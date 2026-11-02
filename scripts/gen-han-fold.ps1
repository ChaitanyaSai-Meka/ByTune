param([string]$Out)
# Traditional -> Simplified, one character at a time, from Windows' own converter (LCMapStringEx, LCMAP_SIMPLIFIED_CHINESE).
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Han {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int LCMapStringEx(string locale, uint flags, string src, int srcLen, StringBuilder dest, int destLen, IntPtr ver, IntPtr res, IntPtr param);
  public static string Simplified(string s) {
    var sb = new StringBuilder(s.Length * 2 + 4);
    int n = LCMapStringEx("zh-CN", 0x02000000, s, s.Length, sb, sb.Capacity, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    return n > 0 ? sb.ToString(0, n) : s;
  }
}
"@
$from = New-Object System.Text.StringBuilder
$to = New-Object System.Text.StringBuilder
$ranges = @(@(0x3400, 0x4DBF), @(0x4E00, 0x9FFF))
foreach ($r in $ranges) {
  for ($cp = $r[0]; $cp -le $r[1]; $cp++) {
    $c = [string][char]$cp
    $s = [Han]::Simplified($c)
    if ($s.Length -eq 1 -and $s -ne $c) { [void]$from.Append($c); [void]$to.Append($s) }
  }
}
$json = '{"from":' + (ConvertTo-Json $from.ToString()) + ',"to":' + (ConvertTo-Json $to.ToString()) + '}'
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding $false))
"pairs: " + $from.Length
