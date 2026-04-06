param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [string]$OutputDir = ".\downloads\claude-code",

    [switch]$IncludeCompressed
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Claude Code 公开 GCS 分发根地址
$Bucket = "claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819"
$BaseUrl = "https://storage.googleapis.com/$Bucket/claude-code-releases"

# 输出目录结构：<OutputDir>\<Version>\
$VersionRoot = Join-Path $OutputDir $Version
New-Item -ItemType Directory -Force -Path $VersionRoot | Out-Null

function Invoke-CurlText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url
    )

    $content = & curl.exe -L --http1.1 --silent --show-error --fail --max-time 60 $Url
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($content)) {
        throw "请求失败：$Url"
    }
    return $content
}

function Download-File {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,

        [Parameter(Mandatory = $true)]
        [string]$OutFile
    )

    $dir = Split-Path -Parent $OutFile
    if (-not [string]::IsNullOrWhiteSpace($dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }

    Write-Host "下载 -> $Url" -ForegroundColor Cyan
    & curl.exe `
        -L `
        --http1.1 `
        --fail `
        --show-error `
        --retry 3 `
        --retry-delay 2 `
        --connect-timeout 15 `
        --max-time 0 `
        --output $OutFile `
        --url $Url

    if ($LASTEXITCODE -ne 0) {
        throw "下载失败：$Url"
    }
}

function Try-DownloadOptionalFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,

        [Parameter(Mandatory = $true)]
        [string]$OutFile
    )

    $dir = Split-Path -Parent $OutFile
    if (-not [string]::IsNullOrWhiteSpace($dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }

    Write-Host "尝试下载可选文件 -> $Url" -ForegroundColor DarkCyan
    & curl.exe `
        -L `
        --http1.1 `
        --fail `
        --silent `
        --show-error `
        --retry 2 `
        --retry-delay 2 `
        --connect-timeout 15 `
        --max-time 0 `
        --output $OutFile `
        --url $Url 2>$null

    if ($LASTEXITCODE -ne 0) {
        Write-Warning "可选文件不存在或下载失败，已跳过：$Url"
        if (Test-Path -LiteralPath $OutFile) {
            Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
        }
        return $false
    }

    return $true
}

function Get-Sha256Hex {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

Write-Host "==> 目标版本：$Version" -ForegroundColor Yellow
Write-Host "==> 输出目录：$([IO.Path]::GetFullPath($VersionRoot))" -ForegroundColor Yellow

# 1. 获取 manifest，先确认该版本是否公开存在
$ManifestUrl = "$BaseUrl/$Version/manifest.json"
Write-Host "==> 获取 manifest：$ManifestUrl" -ForegroundColor Yellow

try {
    $ManifestText = Invoke-CurlText -Url $ManifestUrl
} catch {
    throw "公开 GCS 中找不到版本 $Version 的 manifest.json。这个版本可能未公开发布，或者公开 bucket 不存在。"
}

$ManifestPath = Join-Path $VersionRoot "manifest.json"
Set-Content -LiteralPath $ManifestPath -Value $ManifestText -Encoding utf8

$Manifest = $ManifestText | ConvertFrom-Json
if (-not $Manifest.platforms) {
    throw "manifest.json 结构异常：缺少 platforms 字段。"
}

$PlatformProps = @($Manifest.platforms.PSObject.Properties)
if ($PlatformProps.Count -eq 0) {
    throw "manifest.json 中没有任何平台信息。"
}

Write-Host "==> 检测到平台：" -ForegroundColor Green
$PlatformProps | ForEach-Object { Write-Host ("    - " + $_.Name) }

# 2. 逐平台下载主二进制
$Index = 0
foreach ($Prop in $PlatformProps) {
    $Index++
    $Platform = $Prop.Name
    $PlatformInfo = $Prop.Value

    $BinaryName = if ($Platform.StartsWith("win32")) { "claude.exe" } else { "claude" }
    $BinaryUrl = "$BaseUrl/$Version/$Platform/$BinaryName"

    $PlatformDir = Join-Path $VersionRoot $Platform
    $BinaryPath = Join-Path $PlatformDir $BinaryName

    Write-Host ""
    Write-Host ("[{0}/{1}] 平台：{2}" -f $Index, $PlatformProps.Count, $Platform) -ForegroundColor Magenta

    Download-File -Url $BinaryUrl -OutFile $BinaryPath

    # 3. 使用 manifest 里的 checksum 做校验
    $ExpectedChecksum = ""
    if ($null -ne $PlatformInfo -and $null -ne $PlatformInfo.checksum) {
        $ExpectedChecksum = [string]$PlatformInfo.checksum
    }

    if (-not [string]::IsNullOrWhiteSpace($ExpectedChecksum)) {
        $ExpectedChecksum = $ExpectedChecksum.ToLowerInvariant()
        $ActualChecksum = Get-Sha256Hex -Path $BinaryPath

        if ($ActualChecksum -ne $ExpectedChecksum) {
            Remove-Item -LiteralPath $BinaryPath -Force -ErrorAction SilentlyContinue
            throw "校验失败：$Platform`n期望：$ExpectedChecksum`n实际：$ActualChecksum"
        }

        Write-Host "校验通过：$Platform" -ForegroundColor Green
    } else {
        Write-Warning "manifest 中没有 $Platform 的 checksum，已跳过校验。"
    }

    # 4. 可选下载压缩对象，方便后续做打包结构对比
    if ($IncludeCompressed) {
        if ($Platform.StartsWith("darwin")) {
            Try-DownloadOptionalFile `
                -Url "$BaseUrl/$Version/$Platform/claude.zst" `
                -OutFile (Join-Path $PlatformDir "claude.zst") | Out-Null

            Try-DownloadOptionalFile `
                -Url "$BaseUrl/$Version/$Platform/claude.app.tar.zst" `
                -OutFile (Join-Path $PlatformDir "claude.app.tar.zst") | Out-Null
        } else {
            Try-DownloadOptionalFile `
                -Url "$BaseUrl/$Version/$Platform/$BinaryName.zst" `
                -OutFile (Join-Path $PlatformDir "$BinaryName.zst") | Out-Null
        }
    }
}

Write-Host ""
Write-Host "全部完成。" -ForegroundColor Green
Write-Host ("输出目录：{0}" -f ([IO.Path]::GetFullPath($VersionRoot))) -ForegroundColor Green
