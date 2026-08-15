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
$fail = 0;
foreach ($tests as $t) {
    $h = sanitize_html($t);
    $p = html_to_plain($h, 5000);
    $bad = preg_match('/<\?xml|<\s*script|on[a-z]+\s*=|style\s*=/i', $h) ? ' [BAD OUTPUT]' : '';
    $empty = $p === '' ? ' [EMPTY PLAIN]' : '';
    if ($bad || $empty) $fail++;
    echo "in : $t\nout: $h\nplain: [$p]$bad$empty\n\n";
}
if (sanitize_html('<a href="javascript:alert(1)">x</a>') !== '<a>x</a>') { echo "FAIL: javascript href\n"; $fail++; }
if (sanitize_html('<a href="https://ok.example/a">x</a>') !== '<a href="https://ok.example/a" target="_blank" rel="noopener noreferrer">x</a>') { echo "FAIL: ok href\n"; $fail++; }
echo $fail ? "== $fail SANITIZER FAILURES ==\n" : "== SANITIZER OK ==\n";
