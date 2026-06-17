# Windows Capture Helper Service
# This script starts a local HTTP listener on port 9999 to allow silent capturing of specific windows on Windows.

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:9999/")
try {
    $listener.Start()
} catch {
    Write-Error "Failed to start listener. Port 9999 may be in use or requires administration rights."
    exit 1
}

Write-Host "========================================================" -ForegroundColor Green
Write-Host "  Windows capture helper started on http://localhost:9999/" -ForegroundColor Green
Write-Host "  Press Ctrl+C to exit." -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green

# Load drawing classes
Add-Type -AssemblyName System.Drawing

$Win32Source = @"
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
using System.Text;

public class Win32 {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@
Add-Type -TypeDefinition $Win32Source

# Shared state to capture hwnd in delegate
$script:foundHwnd = [IntPtr]::Zero
$script:titleKeyword = ""

$enumProc = [Win32+EnumWindowsProc] {
    param($hwnd, $lparam)
    if ([Win32]::IsWindowVisible($hwnd)) {
        $sb = New-Object System.Text.StringBuilder 256
        [void][Win32]::GetWindowText($hwnd, $sb, 256)
        $title = $sb.ToString()
        if ($title.ToLower().Contains($script:titleKeyword.ToLower())) {
            $script:foundHwnd = $hwnd
            return $false # Found it, stop enumeration
        }
    }
    return $true # Continue searching
}

function Find-TargetWindow ($keyword) {
    $script:foundHwnd = [IntPtr]::Zero
    $script:titleKeyword = $keyword
    [Win32]::EnumWindows($enumProc, [IntPtr]::Zero)
    return $script:foundHwnd
}

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        # CORS Headers
        $response.Headers.Add("Access-Control-Allow-Origin", "*")
        $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
        $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")

        if ($request.HttpMethod -eq "OPTIONS") {
            $response.StatusCode = 200
            $response.Close()
            continue
        }

        if ($request.HttpMethod -eq "POST" -and $request.Url.LocalPath -eq "/capture") {
            $reader = New-Object System.IO.StreamReader($request.InputStream)
            $body = $reader.ReadToEnd()
            $reader.Close()

            # Extract windowTitle keyword using regex
            $keyword = "腾讯会议"
            if ($body -match '"windowTitle"\s*:\s*"([^"]+)"') {
                $keyword = $Matches[1]
            }

            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Capturing window containing: '$keyword'" -ForegroundColor Cyan

            # Find window handle
            $hwnd = Find-TargetWindow -keyword $keyword
            if ($hwnd -eq [IntPtr]::Zero) {
                # Attempt direct class name or exact window title search
                $hwnd = [Win32]::FindWindow($null, $keyword)
            }

            if ($hwnd -eq [IntPtr]::Zero) {
                $errMsg = "Window not found matching keyword '$keyword'."
                Write-Host "  Error: $errMsg" -ForegroundColor Yellow
                $response.StatusCode = 404
                $jsonErr = '{"error":"Window not found"}'
                $buffer = [System.Text.Encoding]::UTF8.GetBytes($jsonErr)
                $response.ContentType = "application/json"
                $response.ContentLength64 = $buffer.Length
                $response.OutputStream.Write($buffer, 0, $buffer.Length)
                $response.Close()
                continue
            }

            # Read bounds
            $rect = New-Object Win32+RECT
            [Win32]::GetWindowRect($hwnd, [ref]$rect)
            $w = $rect.Right - $rect.Left
            $h = $rect.Bottom - $rect.Top

            if ($w -le 0 -or $h -le 0) {
                $w = 1280
                $h = 720
            }

            # Create bitmap and graphics context
            $bmp = New-Object System.Drawing.Bitmap($w, $h)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $hdc = $g.GetHdc()
            try {
                # PW_RENDERFULLCONTENT = 2
                [void][Win32]::PrintWindow($hwnd, $hdc, 2)
            } finally {
                $g.ReleaseHdc($hdc)
                $g.Dispose()
            }

            # Save to memory stream as PNG
            $ms = New-Object System.IO.MemoryStream
            $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
            
            $bytes = $ms.ToArray()
            $ms.Close()
            $base64 = [Convert]::ToBase64String($bytes)

            $jsonResponse = '{"base64":"' + $base64 + '","width":' + $w + ',"height":' + $h + '}'
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($jsonResponse)

            $response.StatusCode = 200
            $response.ContentType = "application/json"
            $response.ContentLength64 = $buffer.Length
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
            $response.Close()
            Write-Host "  Success: Captured window ($w x $h)." -ForegroundColor Green
        } else {
            $response.StatusCode = 404
            $response.Close()
        }
    } catch {
        Write-Host "  Error processing request: $_" -ForegroundColor Red
        if ($null -ne $response) {
            try {
                $response.StatusCode = 500
                $response.Close()
            } catch {}
        }
    }
}
