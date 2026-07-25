/**
 * Renders untrusted source text.
 *
 * Content arrives as React text children inside a `<pre>`, so React escapes it.
 * There is deliberately no `dangerouslySetInnerHTML`, no Markdown renderer, and
 * nothing that could load remote content: planning files are untrusted input
 * (CT-03 §5.16, CT03-A65).
 */
export function SourceText({ text, label }: { text: string; label: string }) {
  return (
    <section className="source-text-region" aria-label={label}>
      <pre className="source-text" data-testid="source-text">
        {text}
      </pre>
    </section>
  );
}
