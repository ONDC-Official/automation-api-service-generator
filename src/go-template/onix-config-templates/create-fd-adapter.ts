import yaml from "js-yaml";
import {
    AdapterParams,
    createFormRouter,
    createMockNoConfig,
    createNpNoConfig,
    getMiddlwarePlugin,
    getRounterPlugin,
} from "./create-adapter.js";

// FD (ONDC:FIS14:FD) route table, as @ondc/build-tools writes it into build.yaml
// (`x-fd-routes`). Only the fields read here; the full format is FD-ROUTE-TABLE.md.
export interface FdRouteTable {
    formatVersion: number;
    domain: string;
    version: string;
    tableHash: string;
    routes: {
        action: string;
        kind: "request" | "callback" | "webhook";
        mode: "SYNC" | "ASYNC_ACK_CALLBACK" | "WEBHOOK";
    }[];
}

// Where fd-gate and fd-transport read the route table inside the image.
const ROUTE_TABLE_PATH = "./config/fd_routes.yaml";

/**
 * The FD service's config files. FD addresses REST resources, so its modules are named after
 * FD's roles and every module is fronted by fd-gate, which resolves the method and path to an
 * action through the route table:
 *
 *   issuer/        the workbench plays the Deposit Issuer; an Investor App under test calls it
 *   investor-app/  the workbench plays the Investor App; an Issuer under test calls it
 *   mock/          internal: the mock playground sends the workbench's messages through it
 *
 * Steps are the Beckn receiver's and mock's, without the built-in sign/validateSign: FD
 * signatures cover (request-target), so fd-gate verifies them and fd-transport signs.
 * SYNC actions answer in the HTTP response, so their routes proxy to the mock instead of
 * acknowledging first.
 */
export function createFdAdapterFiles(params: AdapterParams, routes: FdRouteTable) {
    const files: { path: string; content: string }[] = [];
    files.push({
        path: "./adapter.yaml",
        content: yaml.dump(createFdAdapterYaml(params)),
    });
    files.push({
        path: "./form_router.yaml",
        content: yaml.dump(createFormRouter(params)),
    });
    files.push({
        path: "./mock_router.yaml",
        content: yaml.dump(createFdMockRouter(params, routes)),
    });
    files.push({
        path: "./np_router.yaml",
        content: yaml.dump(createFdNpRouter(params, routes)),
    });
    files.push({
        path: "./mock_no_config.yaml",
        content: yaml.dump(withFdRemap(createMockNoConfig(params))),
    });
    files.push({
        path: "./np_no_config.yaml",
        content: yaml.dump(withFdRemap(createNpNoConfig(params))),
    });
    files.push({
        path: "./fd_routes.yaml",
        content: yaml.dump(routes),
    });
    if (params.transactionProperties) {
        files.push({
            path: "./transaction_properties.yaml",
            content: yaml.dump(params.transactionProperties),
        });
    }
    return files;
}

function createFdAdapterYaml(params: AdapterParams) {
    const base = `/api-service/${params.domain}/${params.version}`;
    let httpClientConfig = {
        maxIdleConns: 1000,
        maxIdleConnsPerHost: 200,
        idleConnTimeout: "300s",
        responseHeaderTimeout: "20s",
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
                ...(params.transactionProperties !== undefined && {
                    transactionPropertiesPath:
                        "./config/transaction_properties.yaml",
                }),
            },
        };
    };

    // fd-gate is listed first, so it is the outermost middleware: it sees the participant's
    // request before anything else and the response last. In np mode it verifies the FD
    // signature, translates the REST call into the internal POST .../<action> the steps
    // understand, enforces the transport rules and answers replays; in mock mode it checks the
    // playground's internal key. `addr` and `mockServiceURL` are rewritten by the entrypoint
    // like the cache's and the workbench plugin's.
    const fdGatePlugin = (mode: "np" | "mock", modulePath: string) => {
        return {
            id: "fdgate",
            config: {
                routeTable: ROUTE_TABLE_PATH,
                mode: mode,
                pathPrefix: modulePath,
                addr: params.redisAddress,
                mockServiceURL: params.mockServiceURL,
                signature: mode === "np" ? "required" : "off",
                requireHTTPS: true,
            },
        };
    };

    // Requests to these hosts stay inside the workbench and keep their internal headers.
    const internalHosts = internalHostsOf(params.mockServiceURL);
    // fd-transport renders the REST call and signs it, with the workbench identity from the
    // environment (SUBSCRIBER_ID, UNIQUE_KEY_ID, SIGNING_PRIVATE), as the key manager reads it.
    const fdTransportPlugin = {
        id: "fdtransport",
        config: {
            routeTable: ROUTE_TABLE_PATH,
            ...(internalHosts && { internalHosts: internalHosts }),
        },
    };

    const receiverHandler = (role: string, modulePath: string) => {
        return {
            type: "std",
            role: role.toLowerCase(),
            httpClientConfig: httpClientConfig,
            plugins: {
                cache: cachePlugin,
                keyManager: keymanger,
                middleware: [
                    fdGatePlugin("np", modulePath),
                    getMiddlwarePlugin("np_no_config"),
                ],
                transportWrapper: fdTransportPlugin,
                router: getRounterPlugin("np_router"),
                schemaValidator: schemaPlugin,
                ondcValidator: ondcValidatorPlugin,
                ondcWorkbench: ondcWorkbenchPlugin(role.toUpperCase(), "receiver"),
            },
            steps: [
                "ondcWorkbenchReceiver",
                "addRoute",
                "validateSchema",
                "validateOndcPayload",
                "ondcWorkbenchValidateContext",
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
            middleware: [
                fdGatePlugin("mock", `${base}/mock`),
                getMiddlwarePlugin("mock_no_config"),
            ],
            transportWrapper: fdTransportPlugin,
            router: getRounterPlugin("mock_router"),
            schemaValidator: schemaPlugin,
            ondcValidator: ondcValidatorPlugin,
            ondcWorkbench: ondcWorkbenchPlugin("BAP", "caller"),
        },
        steps: [
            "ondcWorkbenchReceiver",
            "addRoute",
            "validateSchema",
            "ondcWorkbenchValidateContext",
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
                path: `${base}/form/html-form`,
                handler: {
                    type: "std",
                    role: "bap",
                    httpClientConfig: httpClientConfig,
                    plugins: {
                        router: getRounterPlugin("form_router"),
                    },
                    steps: ["addRoute"],
                },
            },
            {
                name: "standaloneValidator",
                path: `${base}/test/`,
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
                    steps: ["validateSchema", "validateOndcPayload"],
                },
            },
            {
                // An Investor App under test calls the workbench's issuer (Beckn's seller/).
                name: "InvestorAppTxnReceiver",
                path: `${base}/issuer/`,
                handler: receiverHandler("BAP", `${base}/issuer`),
            },
            {
                // An Issuer under test calls the workbench's investor app (Beckn's buyer/).
                name: "IssuerTxnReceiver",
                path: `${base}/investor-app/`,
                handler: receiverHandler("BPP", `${base}/investor-app`),
            },
            {
                name: "mockTxnCaller",
                path: `${base}/mock/`,
                handler: mockHandler,
            },
        ],
    };

    return adapterConfig;
}

// Participant-facing modules forward to the mock. SYNC actions proxy, so the mock's answer
// returns in the participant's HTTP response; every other action is acknowledged first and
// forwarded after.
function createFdNpRouter(params: AdapterParams, routes: FdRouteTable) {
    const sync = routes.routes.filter((r) => r.mode === "SYNC").map((r) => r.action);
    const async = routes.routes.filter((r) => r.mode !== "SYNC").map((r) => r.action);
    const rule = (actAsProxy: boolean, endpoints: string[]) => ({
        domain: params.domain,
        version: params.version,
        targetType: "jsonPath",
        target: {
            jsonPath: "$.cookies.mock_url",
        },
        actAsProxy: actAsProxy,
        endpoints: endpoints,
    });
    return {
        routingRules: [
            ...(async.length > 0 ? [rule(false, async)] : []),
            ...(sync.length > 0 ? [rule(true, sync)] : []),
        ],
    };
}

function createFdMockRouter(params: AdapterParams, routes: FdRouteTable) {
    return {
        routingRules: [
            {
                domain: params.domain,
                version: params.version,
                targetType: "jsonPath",
                target: {
                    jsonPath: "$.cookies.subscriber_url",
                },
                actAsProxy: true,
                endpoints: routes.routes.map((r) => r.action),
            },
        ],
    };
}

// The FD services record what the Beckn ones do, plus FD's own correlation and transport facts:
// the request a callback answers, and the REST call fd-gate resolved (from its internal headers,
// which network-observability sees lower-cased).
function withFdRemap<T extends { remap: Record<string, unknown> }>(config: T): T {
    return {
        ...config,
        remap: {
            ...config.remap,
            in_reply_to: "$.requestBody.fdEnvelope.inReplyTo",
            fd_route: "$.ctx.headers['x-pwb-fd-route']",
            fd_method: "$.ctx.headers['x-pwb-fd-method']",
            fd_path: "$.ctx.headers['x-pwb-fd-path']",
            duration_ms: "$.ctx.duration_ms",
        },
    };
}

function internalHostsOf(...urls: string[]) {
    const hosts = new Set<string>();
    for (const raw of urls) {
        try {
            const host = new URL(raw).host;
            if (host) hosts.add(host);
        } catch {
            // an unset or relative URL names no host
        }
    }
    return [...hosts].join(",");
}
