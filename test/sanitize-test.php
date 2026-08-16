<?php
require __DIR__ . '/../src/sanitize.php';
$tests = [
    '<p>Hello <b>world</b></p><script>alert(1)</script><img src=x onerror=alert(2)>',
    '<a href="javascript:alert(1)">bad</a>',
    '<a href="https://ok.example/a">ok</a>',
    '<ul><li>one</li><li>two</li></ul>',
    '<p style="color:red" onclick="x()">styled</p>',
    '<b>hi</b> <script>x</script>',
];
// The unwrap bug: children of a disallowed element were moved up without
// being sanitized, so a <title>-wrapped <script> or a <form>-wrapped
// <input autofocus onfocus=...> survived as executable markup.
$regressions = [
    '<title><script>window.__xss=1</script></title>',
    '<form><input autofocus onfocus="window.__xss=2"></form>',
    '<title><a href="javascript:alert(1)">t</a></title>',
    '<!--[if IE]><script>window.__xss=3</script><![endif]-->',
    '<iframe srcdoc="<script>window.__xss=4</script>"></iframe>',
    '<svg><script>window.__xss=5</script></svg>',
];
$fail = 0;
foreach ($tests as $t) {
    $h = sanitize_html($t);
    $p = html_to_plain($h, 5000);
    $bad = preg_match('/<\?xml|<\s*script|on[a-z]+\s*=|style\s*=|javascript\s*:|<input|<form|<title|<svg|<!--/i', $h) ? ' [BAD OUTPUT]' : '';
    $empty = $p === '' ? ' [EMPTY PLAIN]' : '';
    if ($bad || $empty) $fail++;
    echo "in : $t\nout: $h\nplain: [$p]$bad$empty\n\n";
}
// The regression payloads legitimately sanitize to empty text — only a
// surviving executable construct is a failure.
foreach ($regressions as $t) {
    $h = sanitize_html($t);
    $bad = preg_match('/<\?xml|<\s*script|on[a-z]+\s*=|style\s*=|javascript\s*:|<input|<form|<title|<svg|<!--/i', $h) ? ' [BAD OUTPUT]' : '';
    if ($bad) $fail++;
    echo "in : $t\nout: [$h]$bad\n\n";
}
if (sanitize_html('<a href="javascript:alert(1)">x</a>') !== '<a>x</a>') { echo "FAIL: javascript href\n"; $fail++; }
if (sanitize_html('<a href="https://ok.example/a">x</a>') !== '<a href="https://ok.example/a" target="_blank" rel="noopener noreferrer">x</a>') { echo "FAIL: ok href\n"; $fail++; }
if (sanitize_html('<title><script>x</script></title>') !== 'x') { echo "FAIL: title-wrap regression\n"; $fail++; }
if (sanitize_html('<form><input autofocus onfocus="x()">') !== '') { echo "FAIL: form/input regression\n"; $fail++; }
if (sanitize_html('<!--[if IE]><script>x</script><![endif]-->') !== '') { echo "FAIL: comment regression\n"; $fail++; }
echo $fail ? "== $fail SANITIZER FAILURES ==\n" : "== SANITIZER OK ==\n";
