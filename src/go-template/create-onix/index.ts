import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import fs from "fs";
import { loadAndDereferenceYaml } from "../../utils/yaml-utils.js";
import { createOnixEnvFile } from "../../utils/env-file.js";
import { createAdapterFiles } from "../onix-config-templates/create-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ONIX_PLUGINS_GIT =
	"https://github.com/ONDC-Official/automation-beckn-plugins";
const BUILD_OUTPUT = path.resolve(__dirname, "../../../build-output");

export const CreateOnixServer = async () => {
	console.log("Creating API Service Layer via ONIX...");

	const buildPath = path.resolve(__dirname, "../../../src/config/build.yaml");
	const buildParsed = (await loadAndDereferenceYaml(buildPath)) as any;
	const version = buildParsed.info.version as string;
	const domain = buildParsed.info.domain as string;
	const domainFilename = domain.toLowerCase().replace(":", "_");
	const versionFileName = `v${version}`;

	// Step 2: Generate schemas
	await generateSchemas(
		domain,
		version,
		domainFilename,
		versionFileName,
		buildPath
	);

	// Step 3: Clone Plugins repository
	await clonePlugins();

	// Step 4: Generate L1 validations
	await generateL1Validations(buildPath);

	// Step 5: Update go.mod to point to correct validationpkg path
	await updateGoModPath();

	// Step 7: Generate .env file
	await createOnixEnvFile();

	// Step 8: Create adapter configuration files
	await createAdapterConfigs(domain, version);

	await copyDockerAndComposeFiles();
};

async function generateSchemas(
	domain: string,
	version: string,
	domainFilename: string,
	versionFileName: string,
	buildPath: string
) {
	const outputPath = path.resolve(
		BUILD_OUTPUT,
		`temp/schemas/${domainFilename}/${versionFileName}`
	);

	console.log(`Generating schemas for ${domain} version ${version}...`);

	if (!fs.existsSync(outputPath)) {
		fs.mkdirSync(outputPath, { recursive: true });
	}

	const scriptPath = path.resolve(
		process.cwd(),
		"scripts/generate-onix-schemas.sh"
	);

	try {
		execSync(`bash ${scriptPath} "${buildPath}" "${outputPath}"`, {
			cwd: process.cwd(),
			stdio: "inherit",
			shell: "/bin/bash",
		});
		console.log(`✅ Schemas generated successfully at ${outputPath}`);
	} catch (error: any) {
		console.error("❌ Schema generation failed!");
		console.error("Error:", error.message);
		throw error;
	}
}

async function clonePlugins() {
	const tempPath = path.resolve(BUILD_OUTPUT, "temp");
	const pluginsPath = path.resolve(tempPath, "automation-beckn-plugins");

	if (!fs.existsSync(tempPath)) {
		fs.mkdirSync(tempPath, { recursive: true });
	}

	if (!fs.existsSync(pluginsPath)) {
		console.log("Cloning Plugins repository...");
		execSync(
			`git clone --branch main ${ONIX_PLUGINS_GIT} automation-beckn-plugins`,
			{
				cwd: tempPath,
				stdio: "inherit",
			}
		);
		console.log("✅ Plugins repository cloned successfully.");
	} else {
		console.log("Plugins repository already exists, skipping clone.");
	}
}

async function generateL1Validations(buildPath: string) {
	const outputPath = path.resolve(BUILD_OUTPUT, "temp/");

	console.log("Generating L1 validations...");

	if (!fs.existsSync(outputPath)) {
		fs.mkdirSync(outputPath, { recursive: true });
	}

	const scriptPath = path.resolve(
		process.cwd(),
		"scripts/generate-l1-validations.sh"
	);

	try {
		execSync(`bash ${scriptPath} "${buildPath}" "${outputPath}"`, {
			cwd: process.cwd(),
			stdio: "inherit",
			shell: "/bin/bash",
		});
		console.log(`✅ L1 validations generated successfully at ${outputPath}`);
	} catch (error: any) {
		console.error("❌ L1 validation generation failed!");
		console.error("Error:", error.message);
		throw error;
	}
}

async function updateGoModPath() {
	const pluginsPath = path.resolve(
		BUILD_OUTPUT,
		"temp/automation-beckn-plugins"
	);
	const goModPath = path.resolve(pluginsPath, "go.mod");

	console.log("Updating go.mod path...");

	try {
		let goModContent = fs.readFileSync(goModPath, "utf-8");

		// Replace the validationpkg path from ./ondc-validator/validationpkg to ../validationpkg
		goModContent = goModContent.replace(
			/replace validationpkg => \.\/ondc-validator\/validationpkg/g,
			"replace validationpkg => ../validationpkg"
		);

		fs.writeFileSync(goModPath, goModContent, "utf-8");
		console.log("✅ go.mod updated successfully.");
	} catch (error: any) {
		console.error("❌ Failed to update go.mod!");
		console.error("Error:", error.message);
		throw error;
	}
}

async function createAdapterConfigs(domain: string, version: string) {
	const configDir = path.resolve(BUILD_OUTPUT, "temp/config");

	if (!fs.existsSync(configDir)) {
		fs.mkdirSync(configDir, { recursive: true });
	}

	console.log("Creating adapter configuration files...");

	try {
		const params = {
			domain: domain,
			version: version,
			port: parseInt(process.env.PORT || "8080"),
			redisAddress: `${process.env.REDIS_HOST || "localhost"}:${process.env.REDIS_PORT || "6379"}`,
			configServiceURL: process.env.CONFIG_SERVICE_URL || "",
			mockServiceURL: process.env.MOCK_SERVER_URL || "",
			recorderServiceHTTP_URL: process.env.RECORDER_SERVICE_HTTP_URL || "",
			recorderServiceGRPC_URL: process.env.RECORDER_SERVICE_GRPC_URL || "",
		};
		console.log("Adapter config parameters:", params);
		const files = createAdapterFiles(params);

		for (const file of files) {
			const filePath = path.resolve(configDir, file.path.replace("./", ""));
			fs.writeFileSync(filePath, file.content, "utf-8");
		}

		console.log(`✅ Adapter configuration files created in ${configDir}`);
	} catch (error: any) {
		console.error("❌ Failed to create adapter configs!");
		console.error("Error:", error.message);
		throw error;
	}
}

async function copyDockerAndComposeFiles() {
	const sourceDockerfile = path.resolve(
		__dirname,
		"../../../src/go-template/onix-config-templates/Dockerfile"
	);
	const destDockerfile = path.resolve(BUILD_OUTPUT, "Dockerfile");
	fs.copyFileSync(sourceDockerfile, destDockerfile);
	const sourceComposeFile = path.resolve(
		__dirname,
		"../../../src/go-template/onix-config-templates/docker-compose.yml"
	);
	const destComposeFile = path.resolve(BUILD_OUTPUT, "docker-compose.yml");
	fs.copyFileSync(sourceComposeFile, destComposeFile);
	console.log(`pasted to ${destDockerfile} and ${destComposeFile}`);
}
