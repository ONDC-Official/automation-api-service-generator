#!/usr/bin/env node
import { readFileSync } from "fs";
import fse from "fs-extra";
import { ConfigCompiler } from "ondc-code-generator";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { loadAndDereferenceYaml } from "./utils/yaml-utils.js";
import { SupportedLanguages } from "ondc-code-generator/dist/types/compiler-types.js";
import dotenv from "dotenv";
import { clearAndCopy } from "./utils/fs-utilts.js";
import { createEnvFile } from "./utils/env-file.js";
import fs from "fs";
import { CreateOnixServer } from "./go-template/create-onix/index.js";
import { Command } from "commander";
import { createRequire } from "module";

// ── Commander CLI setup ─────────────────────────────────────────────
const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const program = new Command();
program
	.name("ondc-api-service-generator")
	.description("Generate ONDC ONIX API service from a build.yaml spec")
	.version(pkg.version)
	.option("-c, --config <path>", "Path to build.yaml spec file", "./src/config/build.yaml")
	.parse(process.argv);

const cliOptions = program.opts<{ config: string }>();

// Resolve to absolute path relative to cwd (where npx is invoked)
process.env.BUILD_YAML_PATH = path.resolve(process.cwd(), cliOptions.config);

// Load .env AFTER CLI args so CLI values take priority
dotenv.config();

export const createApiServiceLayer = async () => {
	console.log("Creating API Service Layer...");
	const buildString = readFileSync(
		process.env.BUILD_YAML_PATH!,
		"utf8",
	);
	const buildParsed = (await loadAndDereferenceYaml(buildString)) as any;
	const valParsed = buildParsed["x-validations"];
	const comp = new ConfigCompiler(SupportedLanguages.Typescript);
	fse.emptyDirSync(path.resolve(__dirname, "../generated"));
	await comp.initialize(buildString);
	await comp.generateCode(valParsed as any, "L1-validations");
	await comp.generateL0Schema();

	const version = buildParsed.info.version as string;
	const domain = buildParsed.info.domain as string;
	await createEnvFile(domain, version);
	await moveRelevantFiles();
};

const moveRelevantFiles = async () => {
	await clearAndCopy(
		path.resolve(__dirname, "../template/automation-api-service"),
		path.resolve(__dirname, "../build-output/automation-api-service"),
	);
	await clearAndCopy(
		path.resolve(__dirname, "../generated/L1-validations"),
		path.resolve(
			__dirname,
			"../build-output/automation-api-service/src/validations/L1-validations",
		),
	);

	fse.copySync(
		path.resolve(__dirname, "../generated/.env"),
		path.resolve(__dirname, "../build-output/automation-api-service/.env"),
	);

	await clearAndCopy(
		path.resolve(__dirname, "../generated/L0-schemas"),
		path.resolve(
			__dirname,
			"../build-output/automation-api-service/src/validations/L0-schemas",
		),
	);

	if (
		fs.existsSync(
			path.resolve(__dirname, "../src/config/L1-custom-validations"),
		)
	) {
		await clearAndCopy(
			path.resolve(__dirname, "../src/config/L1-custom-validations"),
			path.resolve(
				__dirname,
				"../build-output/automation-api-service/src/validations/L1-custom-validations",
			),
		);
	}
	console.log("deleting generated folder");
	fse.removeSync(path.resolve(__dirname, "../generated"));
};

(async () => {
	console.log("Starting API Service Layer Creation...");

	const isOnix = process.env.IS_ONIX_ENABLED === "true";
	if (!isOnix) {
		console.log("Generating Non-Onix API Service Layer...");
		await createApiServiceLayer();
	} else {
		console.log("Generating Onix API Service Layer...");
		await CreateOnixServer();
	}
	console.log("API Service Layer Creation Completed.");
})();
