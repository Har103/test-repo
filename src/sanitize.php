<?php
declare(strict_types=1);

/**
 * Tiny HTML sanitizer (no libraries).
 * Allowlists the tags our rich-text editor emits; strips everything else,
 * all event handlers and unsafe URLs.
 */

const ALLOWED_TAGS = ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike',
                      'ul', 'ol', 'li', 'h3', 'h4', 'code', 'pre', 'blockquote', 'a'];

function sanitize_html(?string $html): string
{
    if ($html === null || $html === '') {
        return '';
    }
    $html = (string) preg_replace('/(\s|&#?[a-z0-9]+;)*\/\*.*?\*\//is', '', $html); // strip /* */ comments
    $html = (string) preg_replace('/(<[^>]*?)\s+on[a-z]+\s*=([\'"]).*?\2/is', '$1', $html); // event handlers
    $html = (string) preg_replace('/(<[^>]*?)\s+style\s*=([\'"])[^\2]*\2/is', '$1', $html); // styles

    if (class_exists('DOMDocument') && function_exists('libxml_use_internal_errors')) {
        return sanitize_dom($html);
    }

    // Fallback: tag allowlist only, then mirror sanitize_dom's attribute
    // policy so handlers and unsafe hrefs cannot survive on allowed tags.
    $html = (string) preg_replace(
        '#<(?!\s*/?(?:' . implode('|', ALLOWED_TAGS) . ')\b)[^>]*>#is',
        '',
        strip_tags($html, '<' . implode('><', ALLOWED_TAGS) . '>')
    );
    $html = (string) preg_replace('/(<[a-z][^>]*?)\s+(?:on[a-z]+|style)\s*=\s*(?:([\'"])[^\2]*\2|[^\s>]+)/is', '$1', $html);
    $html = (string) preg_replace('~(?:href|src)\s*=\s*([\'"])(?!(?:https?|mailto|#):)[^\1]*\1~i', '', $html);
    return $html;
}

function sanitize_dom(string $html): string
{
    $prev = libxml_use_internal_errors(true);
    $doc = new DOMDocument();
    $doc->loadHTML('<?xml encoding="UTF-8">' . $html, LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD);
    libxml_clear_errors();
    libxml_use_internal_errors($prev);

    // Drop the UTF-8 declaration trick — it would otherwise leak into the
    // output (and confuse strip_tags, which treats `<?` as a PHP open tag).
    foreach (iterator_to_array($doc->childNodes) as $cn) {
        if ($cn instanceof DOMProcessingInstruction) {
            $doc->removeChild($cn);
        }
    }

    $body = $doc->getElementsByTagName('body')->item(0) ?? $doc;
    $nodes = [];
    foreach ($body->childNodes as $node) {
        $nodes[] = $node;
    }
    foreach ($nodes as $node) {
        sanitize_node($doc, $node);
    }

    $out = '';
    foreach ($body->childNodes as $node) {
        $out .= $doc->saveHTML($node);
    }
    return trim($out);
}

function sanitize_node(DOMDocument $doc, DOMNode $node): void
{
    if ($node instanceof DOMComment) {
        // A comment can hide markup from the browser's innerHTML parser
        // (<!--[if IE]><script>…<![endif]-->); drop it outright.
        $node->parentNode->removeChild($node);
        return;
    }
    if ($node instanceof DOMElement) {
        $tag = strtolower($node->tagName);

        if (!in_array($tag, ALLOWED_TAGS, true)) {
            // Unwrap the element, keep its children — but the children were
            // never sanitized, so run them through sanitize_node as they are
            // moved out. Without this, <title><script>alert(1)</script></title>
            // or <form><input autofocus onfocus=alert(1)></form> shed their
            // wrapper and keep the executable payload.
            while ($node->firstChild) {
                $child = $node->firstChild;
                $node->parentNode->insertBefore($child, $node);
                sanitize_node($doc, $child);
            }
            $node->parentNode->removeChild($node);
            return;
        }

        $node->removeAttribute('style');
        $node->removeAttribute('class');
        $node->removeAttribute('id');
        foreach (iterator_to_array($node->attributes) as $attr) {
            if (strncasecmp($attr->nodeName, 'on', 2) === 0) {
                $node->removeAttribute($attr->nodeName);
            }
        }

        if ($tag === 'a') {
            $href = $node->getAttribute('href');
            if (preg_match('~^(https?://|mailto:|#)[^\s]*$~i', (string) $href)) {
                $node->setAttribute('href', $href);
                $node->setAttribute('target', '_blank');
                $node->setAttribute('rel', 'noopener noreferrer');
            } else {
                $node->removeAttribute('href');
            }
        }
        if ($tag === 'code' || $tag === 'pre' || $tag === 'br' || $tag === 'p') {
            // nothing extra
        }
    }

    foreach (iterator_to_array($node->childNodes) as $child) {
        if ($child instanceof DOMText) {
            continue;
        }
        sanitize_node($doc, $child);
    }
}

function html_to_plain(?string $html, int $max = 200): string
{
    $text = html_entity_decode(strip_tags($html ?? ''), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $text = (string) preg_replace('/\s+/u', ' ', $text);
    return mb_strlen($text) > $max ? mb_substr($text, 0, $max) . '…' : $text;
}
