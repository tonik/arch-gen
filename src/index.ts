#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import fs from "fs-extra";
import path from "path";
import { execSync } from "child_process";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, LanguageModel, Provider } from "ai";
import { z } from "zod";
import inquirer from "inquirer";
import Handlebars from "handlebars";

const WorkspaceProjectSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().optional(),
    path: z.string().min(1),
    private: z.boolean().optional(),
    dependencies: z
      .record(
        z.object({ version: z.string(), from: z.string(), path: z.string() }),
      )
      .optional(),
    devDependencies: z
      .record(
        z.object({ version: z.string(), from: z.string(), path: z.string() }),
      )
      .optional(),
  })
  .array();

const packageJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().optional(),
  dependencies: z.record(z.string()).optional(),
  devDependencies: z.record(z.string()).optional(),
});

async function getPnpmWorkspaceProjects(rootPath: string) {
  try {
    // Get list of all workspace packages
    const output = execSync("pnpm ls -r --json --only-projects --depth 1", {
      cwd: rootPath,
      encoding: "utf-8",
    });

    const result = WorkspaceProjectSchema.safeParse(JSON.parse(output));
    if (!result.success) {
      console.error(chalk.red("\nWorkspace projects validation failed:"));
      result.error.errors.forEach((error) => {
        console.error(chalk.yellow(`- Path: ${error.path.join(".")}`));
        console.error(chalk.yellow(`  Error: ${error.message}`));
      });
      throw new Error("Invalid workspace projects structure");
    }

    const packages = result.data;

    const validatedPackages = packages.map((pkg) => {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(pkg.path, "package.json"), "utf-8"),
      );
      const parsedPackageJson = packageJsonSchema.safeParse(packageJson);

      if (!parsedPackageJson.success) {
        console.error(
          chalk.red(`\nPackage.json validation failed for ${pkg.name}:`),
        );
        parsedPackageJson.error.errors.forEach((error) => {
          console.error(chalk.yellow(`- Path: ${error.path.join(".")}`));
          console.error(chalk.yellow(`  Error: ${error.message}`));
        });
        throw new Error(`Invalid package.json in ${pkg.path}`);
      }

      const namespacePrefix = pkg.name.split("/")[0];

      return {
        name: pkg.name,
        namespacePrefix,
        path: path.relative(rootPath, pkg.path),
        dependencies: Object.keys(parsedPackageJson.data.dependencies || {}),
        devDependencies: Object.keys(parsedPackageJson.data.devDependencies || {}),
        description: parsedPackageJson.data.description,
      };
    });

    return validatedPackages;
  } catch (error) {
    console.error(chalk.red("Error reading workspace packages:"), error);
    return [];
  }
}

type WorkspaceProjects = Awaited<ReturnType<typeof getPnpmWorkspaceProjects>>;

async function enhanceDescriptionWithAI(
  model: LanguageModel,
  data: { readmeContents: string; packageJsonContents: string },
): Promise<string> {
  console.log(chalk.blue("Enhancing description with AI..."));
  try {
    const { text } = await generateText({
      model,
      system:
        "You are a technical writer who specializes in creating concise project descriptions. Generate a clear, technical description in 2-3 sentences based on the provided README and package.json contents. Focus on the project's main purpose, key features, and technical stack.",
      prompt: `Please generate a short description for this project based on the following information:
README contents:
${data.readmeContents}

package.json contents:
${data.packageJsonContents}

Remember to keep it technical and concise (2-3 sentences only).`,
      temperature: 0.7,
      maxTokens: 200,
    });

    console.log(chalk.green("AI description generated successfully"));

    const description = text;

    if (!description) {
      throw new Error("AI generated an empty description");
    }

    return description;
  } catch (error) {
    console.error(chalk.yellow("Failed to generate AI description:"), error);

    // Fall back to package.json description or a default message
    const packageJson = JSON.parse(data.packageJsonContents);
    return (
      packageJson.description ||
      "A monorepo project managed with pnpm workspaces."
    );
  }
}

async function generateTechStackWithAI(
  model: LanguageModel,
  data: WorkspaceProjects,
): Promise<string> {
  console.log(chalk.blue("Describing tech stack with AI..."));
  try {
    const internalPrefixes = new Set(data.map((p) => p.namespacePrefix));
    const prompt = `Generate a tech stack description. Directly reference only external packages.
You can use internal ones to get project architecture:

Internal packages:
${data.map((p) => p.name).join("\n")}

External packages:
  ${[
    ...new Set(
      data.flatMap((p) =>
        p.dependencies
          .filter((d) => !internalPrefixes.has(d.split("/")[0]))
          .concat(
            p.devDependencies.filter(
              (d) => !internalPrefixes.has(d.split("/")[0]),
            ),
          ),
      ),
    ),
  ]
    // hard dependencies limit
    .slice(0, 500)
    .join("\n")}
`;
    console.log("Prompt:", prompt);
    const { text } = await generateText({
      model,
      system: `You are a technical writer who specializes in creating concise project descriptions.
Generate a clear, technical description of tech stack in bullet points that will be displayed in markdown.
Don't include all external packages but the most important ones
Use following template: 
- **External Package 1 name**: description
- **External Package 2 name**: description`,
      prompt,
      temperature: 0.7,
      maxTokens: 300,
    });
    return text;
  } catch (error) {
    console.error(chalk.yellow("Failed to generate AI tech stack:"), error);

    return "";
  }
}

function generateFolderTree(projects: Awaited<WorkspaceProjects>): string {
  const tree: { [key: string]: any } = {};

  projects.forEach((project) => {
    const parts = project.path.split("/");
    let current = tree;
    parts.forEach((part, index) => {
      if (!current[part]) {
        current[part] = index === parts.length - 1 ? null : {};
      }
      current = current[part];
    });
  });

  function renderTree(node: any, prefix = "", isLast = true): string {
    const entries = Object.entries(node || {});
    let result = "";

    entries.forEach(([key, value], index) => {
      const isLastItem = index === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      result += `${prefix}${connector}${key}\n`;
      if (value !== null) {
        result += renderTree(value, prefix + childPrefix, isLastItem);
      }
    });

    return result;
  }

  return "```\n" + renderTree(tree) + "```";
}

function generateDependencyGraph(projects: Awaited<WorkspaceProjects>): string {
  let mermaidGraph = "graph TD\n";

  // Add nodes
  projects.forEach((project) => {
    const sanitizedName = project.name.replace(/[@/-]/g, "_");
    mermaidGraph += `  ${sanitizedName}["${project.name}"]\n`;
  });

  // Add dependencies
  projects.forEach((project) => {
    const sanitizedSource = project.name.replace(/[@/-]/g, "_");

    // Only include dependencies that are part of the workspace
    const workspaceDeps = project.dependencies.filter((dep) =>
      projects.some((p) => p.name === dep),
    );

    workspaceDeps.forEach((dep) => {
      const sanitizedTarget = dep.replace(/[@/-]/g, "_");
      mermaidGraph += `  ${sanitizedSource} --> ${sanitizedTarget}\n`;
    });
  });

  return "```mermaid\n" + mermaidGraph + "```";
}

const template = `#{{{ name }}} Architecture

{{{ description }}}

## Technical Stack

{{{ stack }}}

## Project Structure

The following tree represents the organization of packages in this monorepo:

{{{ tree }}}

## Dependeny graph

{{{ graph }}}
`;

async function generateArchitectureDoc(
  projects: WorkspaceProjects,
  rootPath: string,
  aiSettings: AISettings,
): Promise<string> {
  const rootPackageJson = await fs.readJSON(
    path.join(rootPath, "package.json"),
  );

  let description = rootPackageJson.description;
  let stack = "";

  if (aiSettings.useAI) {
    let readmeContents = "";
    let packageJsonContents = "";

    try {
      readmeContents = fs.readFileSync(
        path.join(rootPath, "README.md"),
        "utf-8",
      );
    } catch (error) {
      console.error(chalk.yellow("Failed to read root README.md"), error);
    }

    try {
      packageJsonContents = JSON.stringify(rootPackageJson);
    } catch (error) {
      console.error(chalk.yellow("Failed to read root package.json"), error);
    }

    description = await enhanceDescriptionWithAI(aiSettings.model, {
      readmeContents,
      packageJsonContents,
    });

    stack = await generateTechStackWithAI(aiSettings.model, projects);
  }

  const tree = generateFolderTree(projects);
  const graph = generateDependencyGraph(projects);

  const compiledTemplate = Handlebars.compile(template);
  let doc = compiledTemplate({
    name: rootPackageJson.name,
    description,
    stack,
    tree,
    graph,
  });

  return doc;
}

const program = new Command();

type AISettings =
  | {
      useAI: true;
      model: LanguageModel;
    }
  | {
      useAI: false;
    };

program
  .name("arch-gen")
  .description("CLI tool for generating project architecture documentation")
  .version("1.0.0")
  .option("-r, --root <path>", "Repo root", process.cwd())
  .option(
    "--ai [openaikey]",
    "Use AI to enhance descriptions (requires OPENAI_API_KEY)",
    false,
  )
  .option("-y, --yes", "Auto confirm prompts")
  .action(
    async (options: { root: string; ai?: string | boolean; yes?: boolean }) => {
      const envAiKeyParse = z.string().safeParse(process.env.OPENAI_API_KEY);
      const userAiKey = z.string().safeParse(options.ai);
      let aiSettings: AISettings = { useAI: false };

      if (options.ai) {
        if (!envAiKeyParse.success && !userAiKey.success) {
          throw new Error("OPENAI_API_KEY is required for AI enhancement");
        }

        let provider: Provider | null = null;

        if (userAiKey.success) {
          provider = createOpenAI({
            apiKey: userAiKey.data,
          });

          console.log(chalk.yellow("Using key provided with --ai flag"));
        } else if (envAiKeyParse.success) {
          provider = createOpenAI({
            apiKey: envAiKeyParse.data,
          });
          console.log(chalk.yellow("Using OPENAI_API_KEY from environment"));
        }

        if (!provider) {
          throw new Error("Provider not found");
        }

        aiSettings = { useAI: true, model: provider.languageModel("gpt-4o") };
      }

      console.log(chalk.blue("Analyzing workspace projects..."));

      const projects = await getPnpmWorkspaceProjects(options.root);

      if (projects.length === 0) {
        console.log(chalk.yellow("No workspace projects found."));
        return;
      }
      console.log(chalk.blue("Generating architecture documentation..."));

      const documentation = await generateArchitectureDoc(
        projects,
        options.root,
        aiSettings,
      );

      // Preview the documentation
      console.log(chalk.yellow("\n📄 Preview of ARCHITECTURE.md:"));
      console.log(chalk.dim("─".repeat(80)));
      console.log(documentation);
      console.log(chalk.dim("─".repeat(80)));

      let shouldWrite = true;

      if (!options.yes) {
        const response = await inquirer.prompt([
          {
            type: "confirm",
            name: "shouldWrite",
            message: "Do you want to save this documentation?",
            default: true,
          },
        ]);
        shouldWrite = response.shouldWrite;
      } else {
        console.log(chalk.blue("Auto-confirming due to --yes flag"));
      }

      if (shouldWrite) {
        const outputPath = path.join(options.root, "ARCHITECTURE.md");
        await fs.writeFile(outputPath, documentation);
        console.log(
          chalk.green(
            `✓ Architecture documentation generated at ${outputPath}`,
          ),
        );
      } else {
        console.log(chalk.yellow("Documentation generation cancelled."));
      }
    },
  );

program.parse();
