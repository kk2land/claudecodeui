import matter from 'gray-matter';

const disabledFrontmatterEngine = () => ({});

const frontmatterOptions = {
  language: 'yaml',
  // Disable JS/JSON frontmatter parsing to avoid executable project content.
  // Mirrors Gatsby's mitigation for gray-matter.
  engines: {
    js: disabledFrontmatterEngine,
    javascript: disabledFrontmatterEngine,
    json: disabledFrontmatterEngine,
  },
};

/** Shared utilities and the providers module use this YAML parser without executable frontmatter engines. */
export function parseFrontMatter(content: string) {
  return matter(content, frontmatterOptions);
}
