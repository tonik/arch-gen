# Arch Gen

This is a small tool that generates an ARCHITECTURE file with mono repo diagrams using a single command. It produces `mermaid` diagrams and can optionally enhance descriptions using the `OpenAI API`.

## Requirements

- **pnpm**
- **Monorepo**: A repository that contains multiple projects

## Basic Usage

To use Arch Gen, run the following command:

```bash
npx @tonik/arch-gen [options]
```

### Options

- `--ai [openai-api-key]`: This option generates descriptions and tech stack information with the OpenAI API. If not provided, it will read from the `OPENAI_API_KEY` environment variable.

> **Disclaimer**: When using the AI option, certain data is sent to the OpenAI API for processing. No code files are transmitted. The data includes:
> - Directory names
> - Monorepo file layout with external and internal package names
> - Contents of `package.json`
> - Contents of README files

- `-r, --root <path>`: Specify the root path of the monorepo.
- `-y, --yes`: Skip prompts and generate diagrams with default options.
- `-h, --help`: Display help information.
