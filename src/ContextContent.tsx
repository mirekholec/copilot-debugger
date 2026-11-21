import { Fragment, useMemo, type ReactNode } from 'react';

const xmlName = String.raw`[:_\p{L}][:\w.\p{L}\p{M}\p{N}-]*`;
const xmlQuotedValue = String.raw`"[^"]*"|'[^']*'`;
const xmlMarkup = new RegExp(
  String.raw`<!--[^]*?-->|<!\[CDATA\[[^]*?\]\]>|<\?${xmlName}(?:\s[^]*?)?\?>|</(${xmlName})\s*>|<(${xmlName})((?:\s+${xmlName}\s*=\s*(?:${xmlQuotedValue}))*)\s*(/?)>`,
  'gu'
);
const xmlAttributes = new RegExp(String.raw`(${xmlName})(\s*=\s*)(${xmlQuotedValue})`, 'gu');

interface XmlToken {
  text: string;
  start: number;
  depth: number;
  parent?: XmlToken;
  element?: string;
  closes?: boolean;
  endToken?: number;
  mixedContent?: boolean;
  preserveSpace?: boolean;
}

function scanXml(content: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  const openElements: XmlToken[] = [];
  let previousEnd = 0;

  for (const match of content.matchAll(xmlMarkup)) {
    const [text, closingName, name, attributes = '', selfClosing] = match;
    const start = match.index ?? 0;
    const current = openElements[openElements.length - 1];
    if (current && (/[^ \t\r\n]/.test(content.slice(previousEnd, start)) || text.startsWith('<![CDATA['))) {
      current.mixedContent = true;
    }
    previousEnd = start + text.length;

    if (closingName) {
      if (current?.element === closingName) {
        current.endToken = tokens.length;
        tokens.push({ text, start, depth: current.depth, parent: current, closes: true });
        openElements.pop();
      } else {
        tokens.push({ text, start, depth: 0, closes: true });
        openElements.length = 0;
      }
      continue;
    }

    const space = attributes.includes('xml:space')
      ? [...attributes.matchAll(xmlAttributes)].find((attribute) => attribute[1] === 'xml:space')?.[3]
      : undefined;
    const token: XmlToken = {
      text,
      start,
      depth: openElements.length,
      parent: current,
      element: name,
      preserveSpace: space ? space.slice(1, -1) === 'preserve' : current?.preserveSpace
    };
    if (name && !selfClosing) {
      openElements.push(token);
    } else {
      token.endToken = tokens.length;
    }
    tokens.push(token);
  }

  return tokens;
}

function highlightMarkup(token: XmlToken) {
  const { text, start } = token;
  if (!token.element && !token.closes) {
    return <span key={start} className="ctx-xml-meta">{text}</span>;
  }

  const parts: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(xmlAttributes)) {
    const [attribute, name, equals, value] = match;
    const index = match.index ?? 0;
    parts.push(text.slice(offset, index), (
      <Fragment key={index}>
        <span className="ctx-xml-attribute">{name}</span>{equals}<span className="ctx-xml-value">{value}</span>
      </Fragment>
    ));
    offset = index + attribute.length;
  }
  parts.push(text.slice(offset));
  return <span key={start} className="ctx-xml-tag">{parts}</span>;
}

function formatContextContent(content: string): ReactNode {
  const tokens = scanXml(content);
  if (!tokens.length) return content;

  const parts: ReactNode[] = [];
  let offset = 0;
  let formattedThrough = -1;
  let baseDepth = 0;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const container = token.parent;
    // Reindent only inside complete elements, while highlighting fragments too.
    const indent = index <= formattedThrough && container && !container.mixedContent && !container.preserveSpace
      && !(tokens[index - 1] === container && token.closes);
    const gap = content.slice(offset, token.start);
    parts.push(indent ? '\n' + '  '.repeat(token.depth - baseDepth) : gap, highlightMarkup(token));
    offset = token.start + token.text.length;

    if (index > formattedThrough && token.endToken !== undefined) {
      formattedThrough = token.endToken;
      baseDepth = token.depth;
    }
  }

  parts.push(content.slice(offset));
  return parts;
}

export function ContextContent({ content }: { content: string }) {
  const formatted = useMemo(() => formatContextContent(content), [content]);
  return <pre className="ctx-preview">{formatted}</pre>;
}
