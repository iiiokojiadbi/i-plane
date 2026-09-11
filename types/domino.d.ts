declare module "@mixmark-io/domino" {
  export interface HtmlNode {
    nodeType: number;
    tagName?: string;
    textContent?: string;
    outerHTML?: string;
    nodeValue: string | null;
    childNodes: ArrayLike<HtmlNode>;
    attributes?: ArrayLike<{ name: string; value: string }>;
    setAttribute?(name: string, value: string): void;
    innerHTML: string;
  }
  export function createDocument(): { createElement(name: string): HtmlNode };
}
