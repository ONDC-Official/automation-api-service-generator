import yaml from "js-yaml";

interface AdapterParams {
	domain: string;
	version: string;
	port: number;
	redisAddress: string; // in host:port format
	configServiceURL: string;
	mockServiceURL: string;
	recorderServiceHTTP_URL: string;
	recorderServiceGRPC_URL: string;
}

const ALL_ACTIONS = [
	"search",
	"on_search",
	"select",
	"on_select",
	"init",
	"on_init",
	"confirm",
	"on_confirm",
	"status",
	"on_status",
	"update",
	"on_update",
	"cancel",
	"on_cancel",
	"track",
	"on_track",
	"issue",
	"on_issue",
];

export function createAdapterFiles(params: AdapterParams) {
	const files: { path: string; content: string }[] = [];
	files.push({
		path: "./adapter.yaml",
		content: yaml.dump(createAdapterYaml(params)),
	});
	files.push({
		path: "./form_router.yaml",
		content: yaml.dump(createFormRouter(params)),
	});
	files.push({
		path: "./mock_router.yaml",
		content: yaml.dump(createMockRouter(params)),
	});
	files.push({
		path: "./np_router.yaml",
		content: yaml.dump(createNpRouter(params)),
	});
	files.push({
		path: "./mock_no_config.yaml",
		content: yaml.dump(createMockNoConfig(params)),
	});
	files.push({
		path: "./np_no_config.yaml",
		content: yaml.dump(createNpNoConfig(params)),
	});
	return files;
}

function createAdapterYaml(params: AdapterParams) {
	let httpClientConfig = {
		maxIdleConns: 1000,
		maxIdleConnsPerHost: 200,
		idleConnTimeout: "300s",
		responseHeaderTimeout: "5s",
	};
	const schemaPlugin = {
		id: "schemavalidator",
		config: {
			schemaDir: "./schemas",
		},
	};

	const cachePlugin = {
		id: "cache",
		config: {
			addr: params.redisAddress,
		},
	};

	const keymanger = {
		id: "keymanager",
	};

	const ondcValidatorPlugin = {
		id: "ondcvalidator",
		config: {
			stateFullValidations: true,
			debugMode: false,
		},
	};

	const signValidatorPlugin = {
		id: "signvalidator",
	};

	const ondcWorkbenchPlugin = (role: string, type: string) => {
		return {
			id: "workbench",
			config: {
				protocolVersion: params.version,
				protocolDomain: params.domain,
				moduleRole: role,
				moduleType: type,
				configServiceURL: params.configServiceURL,
				mockServiceURL: params.mockServiceURL,
			},
		};
	};

	const receiverHandler = (role: string, type: string) => {
		return {
			type: "std",
			role: role.toLowerCase(),
			httpClientConfig: httpClientConfig,
			plugins: {
				cache: cachePlugin,
				keyManager: keymanger,
				middleware: [getMiddlwarePlugin("np_no_config")],
				router: getRounterPlugin("np_router"),
				schemaValidator: schemaPlugin,
				ondcValidator: ondcValidatorPlugin,
				ondcWorkbench: ondcWorkbenchPlugin(
					role.toUpperCase(),
					type.toLowerCase()
				),
				signValidator: signValidatorPlugin,
			},
			steps: [
				"ondcWorkbenchReceiver",
				"addRoute",
				"validateSchema",
				"validateOndcPayload",
				"ondcWorkbenchValidateContext",
				"validateSign",
				"validateOndcCallSave",
			],
		};
	};

	const mockHandler = {
		type: "std",
		role: "bpp",
		httpClientConfig: httpClientConfig,
		plugins: {
			cache: cachePlugin,
			keyManager: keymanger,
			middleware: [getMiddlwarePlugin("mock_no_config")],
			router: getRounterPlugin("mock_router"),
			schemaValidator: schemaPlugin,
			ondcValidator: ondcValidatorPlugin,
			ondcWorkbench: ondcWorkbenchPlugin("BAP", "caller"),
			signer: {
				id: "signer",
			},
		},
		steps: [
			"ondcWorkbenchReceiver",
			"addRoute",
			"validateSchema",
			"ondcWorkbenchValidateContext",
			"sign",
			"validateOndcCallSave",
		],
	};

	let adapterConfig = {
		appName: `workbench-onix-${params.domain}-${params.version}`,
		log: {
			level: "debug",
			destinations: [{ type: "stdout" }],
			contextKeys: [
				"transaction_id",
				"message_id",
				"subscriber_id",
				"module_id",
			],
		},
		http: {
			port: params.port,
			timeout: {
				read: 30,
				write: 30,
				idle: 30,
			},
		},
		pluginManager: {
			root: "./plugins",
		},
		modules: [
			{
				name: "formReceiver",
				path: `/api-service/ONDC:${params.domain}/${params.version}/html-form`,
				handler: {
					type: "std",
					role: "bap",
					httpClientConfig: httpClientConfig,
					plugins: {
						router: getRounterPlugin("form_router"),
					},
				},
				steps: ["addRoute"],
			},
			{
				name: "standaloneValidator",
				path: `/api-service/ONDC:${params.domain}/${params.version}/test/`,
				handler: {
					type: "std",
					role: "bap",
					httpClientConfig: httpClientConfig,
					plugins: {
						schemaValidator: schemaPlugin,
						ondcValidator: {
							id: "ondcvalidator",
							config: {
								stateFullValidations: false,
								debugMode: false,
							},
						},
					},
				},
				steps: ["validateSchema", "validateOndcPayload"],
			},
			{
				name: "BapTxnReceiver",
				path: `/api-service/${params.domain}/${params.version}/seller/`,
				handler: receiverHandler("BAP", "receiver"),
			},
			{
				name: "BppTxnReceiver",
				path: `/api-service/${params.domain}/${params.version}/buyer/`,
				handler: receiverHandler("BPP", "receiver"),
			},
			{
				name: "mockTxnCaller",
				path: `/api-service/${params.domain}/${params.version}/mock/`,
				handler: mockHandler,
			},
		],
	};

	return adapterConfig;
}

function createFormRouter(params: AdapterParams) {
	return {
		routingRules: [
			{
				domain: params.domain,
				version: params.version,
				targetType: "url",
				target: {
					url: `${params.recorderServiceHTTP_URL}/html-form`,
					excludeAction: true,
				},
				endpoints: ["html-form"],
			},
		],
	};
}

function createMockRouter(params: AdapterParams) {
	return {
		routingRules: [
			{
				domain: params.domain,
				version: params.version,
				targetType: "jsonPath",
				target: {
					jsonPath: "$.context.subscriber_url",
				},
				actAsProxy: true,
				endpoints: ALL_ACTIONS,
			},
		],
	};
}

function createNpRouter(params: AdapterParams) {
	return {
		routingRules: [
			{
				domain: params.domain,
				version: params.version,
				targetType: "jsonPath",
				target: {
					jsonPath: "$.cookies.mock_url",
				},
				actAsProxy: false,
				endpoints: ALL_ACTIONS,
			},
		],
	};
}

function createMockNoConfig(params: AdapterParams) {
	return {
		transport: "grpc",
		grpc_target: params.recorderServiceGRPC_URL,
		grpc_insecure: true,
		grpc_method: "/beckn.audit.v1.AuditService/LogEvent",
		grpc_timeout_ms: 5000,
		async: false,
		remap: {
			payload_id: "uuid()",
			transaction_id: "$.requestBody.context.transaction_id",
			message_id: "$.requestBody.context.message_id",
			subscriber_url: "$.ctx.cookies.subscriber_url",
			action: "$.requestBody.context.action",
			timestamp: "$.requestBody.context.timestamp",
			api_name: "$.requestBody.context.action",
			status_code: "$.ctx.status",
			ttl_seconds: "$.ctx.cookies.ttl_seconds",
			cache_ttl_seconds: 0,
			is_mock: true,
			session_id: "$.ctx.cookies.session_id",
			req_headers: "$.ctx.headers_all",
		},
	};
}

function createNpNoConfig(params: AdapterParams) {
	return {
		transport: "grpc",
		grpc_target: params.recorderServiceGRPC_URL,
		grpc_insecure: true,
		grpc_method: "/beckn.audit.v1.AuditService/LogEvent",
		grpc_timeout_ms: 5000,
		async: false,
		remap: {
			payload_id: "uuid()",
			transaction_id: "$.requestBody.context.transaction_id",
			message_id: "$.requestBody.context.message_id",
			subscriber_url: "$.requestBody.context.subscriber_url",
			action: "$.requestBody.context.action",
			timestamp: "$.requestBody.context.timestamp",
			api_name: "$.requestBody.context.action",
			status_code: "$.ctx.status",
			ttl_seconds: "$.ctx.cookies.ttl_seconds",
			cache_ttl_seconds: 0,
			is_mock: false,
			session_id: "$.ctx.cookies.session_id",
			req_headers: "$.ctx.headers_all",
		},
	};
}

function getRounterPlugin(routerName: string) {
	return {
		id: "router",
		config: {
			routingConfig: `./config/${routerName}.yaml`,
		},
	};
}

function getMiddlwarePlugin(middlewareName: string) {
	return {
		id: "networkobservability",
		config: {
			configPath: `./config/${middlewareName}.yaml`,
		},
	};
}
