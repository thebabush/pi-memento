import MarkdownIt from 'markdown-it';
import { useMemo } from 'preact/hooks';

// Session text comes from models and tools, so raw HTML stays escaped
// (html: false) and markdown-it's link validation drops javascript: URLs.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const renderLinkOpen = md.renderer.rules.link_open;
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  token?.attrSet('target', '_blank');
  token?.attrSet('rel', 'noreferrer noopener');
  return renderLinkOpen ? renderLinkOpen(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
};

export function Markdown({ text, class: className }: { text: string; class: string }) {
  const html = useMemo(() => md.render(text), [text]);
  return <div class={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
