/**
 * A TypeScript script to create or update a specific GitHub Actions workflow file
 * across all branches in a repository.
 *
 * It reads a local workflow file and pushes its content to each branch.
 *
 * @usage
 * 1. Make sure you have Node.js and ts-node installed.
 * 2. Install dependencies: npm install axios
 * 3. Save this script as `update-all-workflows.ts`.
 * 4. Run the script from your terminal:
 * GITHUB_TOKEN="your_personal_access_token" \
 * ts-node update-all-workflows.ts \
 * --owner="your-github-username" \
 * --repo="your-repo-name" \
 * --sourceFile="./path/to/your-workflow.yml"
 *
 * @notes
 * - The GitHub Personal Access Token (PAT) MUST have the `repo` scope to read branches
 * and write files.
 * - This script will create a commit on every branch where the workflow file is
 * added or changed.
 */

// if empty all are enabled, otherwise only branches matching the regexes in the array will be updated
const ENABLED_BRANCHES = [/.*FIS.*/i];

import axios, { isAxiosError } from "axios";
import type { AxiosInstance } from "axios";

import fs from "fs";
import path from "path";

// --- CONFIGURATION ---
interface ScriptArgs {
	owner: string;
	repo: string;
	sourceFile: string; // The local path to the source workflow file
	token: string;
}

/**
 * Parses command-line arguments and environment variables.
 */
function parseArgs(): ScriptArgs {
	const args: { [key: string]: string } = {};
	process.argv.slice(2).forEach((arg) => {
		if (arg.startsWith("--")) {
			const [key, value] = arg.substring(2).split("=");
			if (key && value) {
				args[key] = value.replace(/"/g, "");
			}
		}
	});

	const token = process.env.GITHUB_TOKEN;

	if (!args.owner || !args.repo || !args.sourceFile || !token) {
		console.error(`
      ❌ Error: Missing required arguments or environment variable.
      Please provide --owner, --repo, --sourceFile, and set the GITHUB_TOKEN environment variable.

      Usage:
      GITHUB_TOKEN="your_pat" ts-node ${process.argv[1]} --owner="owner-name" --repo="repo-name" --sourceFile="./path/to/workflow.yml"
    `);
		process.exit(1);
	}

	if (!fs.existsSync(args.sourceFile)) {
		console.error(`❌ Error: Source file not found at '${args.sourceFile}'`);
		process.exit(1);
	}

	return {
		owner: args.owner,
		repo: args.repo,
		sourceFile: args.sourceFile,
		token: token,
	};
}

/**
 * Fetches all branch names from a GitHub repository, handling pagination.
 */
async function getAllBranches(
	apiClient: AxiosInstance,
	owner: string,
	repo: string,
): Promise<string[]> {
	console.log(`📡 Fetching branches for ${owner}/${repo}...`);
	const allBranches: string[] = [];
	let page = 1;
	const perPage = 100;

	try {
		while (true) {
			const response = await apiClient.get(`/repos/${owner}/${repo}/branches`, {
				params: { per_page: perPage, page: page },
			});
			const branchesOnPage = response.data.map(
				(branch: { name: string }) => branch.name,
			);
			if (branchesOnPage.length === 0) break;

			allBranches.push(...branchesOnPage);
			page++;
		}
		console.log(`✅ Successfully fetched ${allBranches.length} branches.`);
		return allBranches;
	} catch (error) {
		console.error(`❌ Error fetching branches:`, error);
		throw error;
	}
}

/**
 * Creates or updates a file in a specific branch.
 */
async function updateOrCreateFileInBranch(
	apiClient: AxiosInstance,
	args: {
		owner: string;
		repo: string;
		branch: string;
		filePathInRepo: string;
		fileContentBase64: string;
		commitMessage: string;
	},
) {
	const {
		owner,
		repo,
		branch,
		filePathInRepo,
		fileContentBase64,
		commitMessage,
	} = args;
	const url = `/repos/${owner}/${repo}/contents/${filePathInRepo}`;

	try {
		// Step 1: Check if the file already exists to get its SHA
		const { data: existingFile } = await apiClient.get(url, {
			params: { ref: branch },
		});
		const existingContentBase64 = existingFile.content.replace(/\s/g, "");

		if (existingContentBase64 === fileContentBase64) {
			console.log(
				`  🔍 File is already up-to-date in branch '${branch}'. Skipping.`,
			);
			return;
		}

		// Step 2: If content differs, update the file using its SHA
		console.log(`  🔄 Updating file in branch '${branch}'...`);
		await apiClient.put(url, {
			message: `ci: update ${path.basename(filePathInRepo)}`,
			content: fileContentBase64,
			sha: existingFile.sha,
			branch: branch,
		});
		console.log(`  ✅ Successfully updated file in branch '${branch}'.`);
	} catch (error) {
		if (isAxiosError(error) && error.response?.status === 404) {
			// Step 3: If file does not exist (404), create it
			console.log(`  ✨ Creating new file in branch '${branch}'...`);
			await apiClient.put(url, {
				message: commitMessage,
				content: fileContentBase64,
				branch: branch,
			});
			console.log(`  ✅ Successfully created file in branch '${branch}'.`);
		} else {
			// Handle other errors (e.g., branch protection rules)
			const errorMessage = isAxiosError(error)
				? error.response?.data?.message
				: (error as Error).message;
			console.error(
				`  ❌ Failed to process branch '${branch}': ${errorMessage}`,
			);
		}
	}
}

/**
 * Main function to orchestrate the process.
 */
async function main() {
	const { owner, repo, sourceFile, token } = parseArgs();

	console.log("\n--- Workflow Sync Script ---");
	console.log(`Repository:     ${owner}/${repo}`);
	console.log(`Source Workflow:  ${sourceFile}`);
	console.log("----------------------------\n");

	const apiClient = axios.create({
		baseURL: "https://api.github.com",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github.v3+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});

	try {
		// Read and encode the local workflow file
		const localFileContent = fs.readFileSync(sourceFile, "utf-8");
		const fileContentBase64 = Buffer.from(localFileContent).toString("base64");
		const workflowFileName = path.basename(sourceFile);
		const filePathInRepo = `.github/workflows/${workflowFileName}`;
		const commitMessage = `ci: add ${workflowFileName}`;

		// Step 1: Get all branches
		const branches = await getAllBranches(apiClient, owner, repo);
		if (branches.length === 0) {
			console.log("No branches found. Exiting.");
			return;
		}
		// Step 1.5: Filter branches if ENABLED_BRANCHES is set
		if (ENABLED_BRANCHES.length > 0) {
			const regexes = ENABLED_BRANCHES.map((pattern) => new RegExp(pattern));
			const filteredBranches = branches.filter((branch) =>
				regexes.some((regex) => regex.test(branch)),
			);
			console.log(
				`🔍 Filtering branches with patterns ${ENABLED_BRANCHES.join(
					", ",
				)}. ${filteredBranches.length} branches match the criteria.`,
			);
			if (filteredBranches.length === 0) {
				console.log("No branches match the filtering criteria. Exiting.");
				return;
			}
			branches.length = 0; // Clear original array
			branches.push(...filteredBranches); // Add filtered branches
		}

		// Step 2: Process each branch
		console.log(`\n--- Syncing workflow for ${branches.length} branches ---\n`);
		for (const branch of branches) {
			try {
				await updateOrCreateFileInBranch(apiClient, {
					owner,
					repo,
					branch,
					filePathInRepo,
					fileContentBase64,
					commitMessage,
				});
				// Optional delay to avoid hitting secondary rate limits
				await new Promise((resolve) => setTimeout(resolve, 250));
			} catch (error: any) {
				console.error(
					`  ❌ Error processing branch '${branch}': ${error instanceof Error ? error.message : error}`,
				);
			}
		}

		console.log("\n--- All Done! ---");
		console.log(
			"✅ Script finished. The workflow file has been synced across all branches.",
		);
	} catch (error) {
		console.error(error);
		console.error(
			"\n❌ An unrecoverable error occurred. The script will now exit.",
		);
		// process.exit(1);
	}
}

// Execute the main function
main();
