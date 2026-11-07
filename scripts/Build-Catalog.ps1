<#
.SYNOPSIS
    Build a DelveCat catalog from Splunk (read-only) on Windows or with PowerShell 7.

.DESCRIPTION
    Wraps the delvecat-ingest command line (run through uv) so a catalog can be
    built from PowerShell, by hand or from a scheduled task:

      * one instance from parameters, or several from a .psd1 config file
        (each built on its own, then merged so links across instances resolve);
      * the Splunk token is read from an environment variable or asked for
        securely, and only ever passed to the child process through the
        environment, never on the command line;
      * the previous catalog in -Out is reused automatically (--previous), so
        versions and "first seen" dates carry over between builds;
      * the new catalog is written next to the old one and only replaces it
        when the build succeeds.

    DelveCat never changes Splunk: it reads configuration over the REST API
    and runs read-only searches over _internal and _audit.

    Requirements: uv (https://docs.astral.sh/uv/) on PATH and this repository
    checked out (the script finds it from its own location, or use -RepoRoot).

.PARAMETER Url
    Splunk management URL, e.g. https://splunk.example.com:8089.

.PARAMETER Instance
    Short, stable id for the instance (letters, digits, - and _). It becomes
    part of every object's id, so do not change it between builds.

.PARAMETER Config
    A .psd1 file describing several instances (see scripts/catalog.example.psd1).

.PARAMETER Out
    Where to write the catalog: a folder (default, sharded) or, with
    -SingleFile, a .json file. Default: .\catalog

.PARAMETER Fields
    Sample events per sourcetype to discover fields (slower; powers schemas,
    field lineage and data quality checks).

.PARAMETER RedactProfile
    none (default), internal (drop personal names) or public (also pseudonymize
    users, hosts and sources, mask IPs, drop internal URLs). public needs
    DELVECAT_REDACT_SALT set so pseudonyms stay stable between builds.

.EXAMPLE
    $env:DELVECAT_SPLUNK_TOKEN = '...'
    .\scripts\Build-Catalog.ps1 -Url https://splunk.example.com:8089 -Instance prod `
        -WebUrl https://splunk.example.com -Fields -Annotations .\annotations

.EXAMPLE
    .\scripts\Build-Catalog.ps1 -Config .\catalog.psd1 -Out D:\catalog -Strict

.EXAMPLE
    # Splunk Cloud (ACS token in DELVECAT_ACS_TOKEN)
    .\scripts\Build-Catalog.ps1 -Url https://acme.splunkcloud.com:8089 -Instance cloud -AcsStack acme
#>
[CmdletBinding(DefaultParameterSetName = 'Single')]
param(
    [Parameter(ParameterSetName = 'Single', Mandatory = $true)]
    [string] $Url,

    [Parameter(ParameterSetName = 'Single', Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9_-]+$')]
    [string] $Instance,

    [Parameter(ParameterSetName = 'Single')] [string] $InstanceName,
    [Parameter(ParameterSetName = 'Single')] [string] $WebUrl,
    [Parameter(ParameterSetName = 'Single')] [string] $AcsStack,
    [Parameter(ParameterSetName = 'Single')] [string] $Products,
    [Parameter(ParameterSetName = 'Single')] [string] $DeploymentAppsDir,
    [Parameter(ParameterSetName = 'Single')] [string] $TokenEnv = 'DELVECAT_SPLUNK_TOKEN',
    [Parameter(ParameterSetName = 'Single')] [switch] $Fields,
    [Parameter(ParameterSetName = 'Single')] [string[]] $ExtraArgs = @(),

    [Parameter(ParameterSetName = 'Config', Mandatory = $true)]
    [string] $Config,

    [string] $Out = 'catalog',
    [string] $Annotations,
    [string] $AnnotationRepo,
    [string] $AnnotationBranch = 'main',
    [ValidateSet('none', 'internal', 'public')]
    [string] $RedactProfile = 'none',
    [string] $CaBundle,
    [switch] $Insecure,
    [switch] $SingleFile,
    [switch] $NoPrevious,
    [switch] $Strict,
    [string] $RepoRoot
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# --- helpers --------------------------------------------------------------------------

function Resolve-FullPath([string] $Path) {
    # Like Resolve-Path, but for paths that do not exist yet.
    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Invoke-Ingest([string[]] $Arguments) {
    Write-Verbose ("delvecat-ingest " + ($Arguments -join ' '))
    & uv run --project $script:IngestionDir delvecat-ingest @Arguments
    if ($LASTEXITCODE -ne 0) {
        $meaning = switch ($LASTEXITCODE) {
            3 { 'some extractors failed or annotations matched nothing (-Strict)' }
            4 { 'the result did not validate, or the annotations are invalid' }
            default { "exit code $LASTEXITCODE" }
        }
        throw "delvecat-ingest $($Arguments[0]) failed: $meaning"
    }
}

function Get-Secret([string] $Name, [string] $Prompt) {
    # From the environment, or asked for without echoing it.
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ($value) { return $value }
    if (-not [Environment]::UserInteractive) {
        throw "Set the $Name environment variable (no console to ask for it)."
    }
    $secure = Read-Host -AsSecureString -Prompt $Prompt
    $plain = [System.Net.NetworkCredential]::new('', $secure).Password
    if (-not $plain) { throw "No value given for $Name." }
    return $plain
}

function Get-InstanceArgs([hashtable] $I, [string] $Target) {
    if (-not $I.ContainsKey('Instance') -or $I.Instance -notmatch '^[A-Za-z0-9_-]+$') {
        throw "Every instance needs an Instance id (letters, digits, - and _): $($I | Out-String)"
    }
    $a = @('build', '--instance', $I.Instance, '--out', $Target)
    if ($I.ContainsKey('Url') -and $I.Url) { $a += @('--url', $I.Url) }
    if ($I.ContainsKey('Name') -and $I.Name) { $a += @('--instance-name', $I.Name) }
    if ($I.ContainsKey('WebUrl') -and $I.WebUrl) { $a += @('--web-url', $I.WebUrl) }
    if ($I.ContainsKey('AcsStack') -and $I.AcsStack) { $a += @('--acs-stack', $I.AcsStack) }
    if ($I.ContainsKey('Products') -and $I.Products) { $a += @('--products', $I.Products) }
    if ($I.ContainsKey('Only') -and $I.Only) { $a += @('--only', $I.Only) }
    if ($I.ContainsKey('DeploymentAppsDir') -and $I.DeploymentAppsDir) {
        $a += @('--deployment-apps-dir', (Resolve-FullPath $I.DeploymentAppsDir))
    }
    if ($I.ContainsKey('TokenEnv') -and $I.TokenEnv) { $a += @('--token-env', $I.TokenEnv) }
    if ($I.ContainsKey('Fields') -and $I.Fields) { $a += '--fields' }
    if ($I.ContainsKey('NoUsage') -and $I.NoUsage) { $a += '--no-usage' }
    if ($script:CaBundlePath) { $a += @('--ca-bundle', $script:CaBundlePath) }
    if ($script:InsecureTls) { $a += '--insecure' }
    if ($script:StrictBuild) { $a += '--strict' }
    if ($I.ContainsKey('ExtraArgs') -and $I.ExtraArgs) { $a += @($I.ExtraArgs) }
    return , $a
}

function Write-Summary([string] $Path) {
    $manifest = if (Test-Path -LiteralPath $Path -PathType Container) { Join-Path $Path 'catalog.json' } else { $Path }
    try {
        # Windows PowerShell 5.1 cannot parse very large JSON; the summary is optional.
        $bundle = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Write-Host "Catalog written to $Path (summary skipped: $($_.Exception.Message))"
        return
    }
    $entities = 0
    $edges = 0
    if ($bundle.PSObject.Properties['shards'] -and $bundle.shards) {
        foreach ($s in $bundle.shards) {
            if ($s.kind -eq 'entities') { $entities += $s.count } else { $edges += $s.count }
        }
    } else {
        $entities = @($bundle.entities).Count
        $edges = @($bundle.edges).Count
    }
    $instanceCount = if ($bundle.PSObject.Properties['instances']) { @($bundle.instances).Count } else { 0 }
    Write-Host ("Catalog: {0:N0} objects, {1:N0} relationships, {2} instance(s) -> {3}" -f $entities, $edges, $instanceCount, $Path)
    $report = if ($bundle.PSObject.Properties['ingestionReport']) { @($bundle.ingestionReport) } else { @() }
    $problems = @($report | Where-Object { $_.status -ne 'ok' })
    foreach ($r in $problems) {
        $msg = ''
        if ($r.PSObject.Properties['message']) { $msg = " - $($r.message)" }
        $source = if ($r.PSObject.Properties['connector']) { $r.connector } else { 'ingestion' }
        Write-Warning ("{0}: {1}{2}" -f $source, $r.status, $msg)
    }
}

# --- setup ----------------------------------------------------------------------------

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "uv is not on PATH. Install it: https://docs.astral.sh/uv/getting-started/installation/"
}
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$script:IngestionDir = Join-Path (Resolve-FullPath $RepoRoot) 'ingestion'
if (-not (Test-Path -LiteralPath (Join-Path $script:IngestionDir 'pyproject.toml'))) {
    throw "Cannot find the ingestion package under $RepoRoot. Pass -RepoRoot <delvecat checkout>."
}
$script:CaBundlePath = if ($CaBundle) { Resolve-FullPath $CaBundle } else { $null }
$script:InsecureTls = [bool] $Insecure
$script:StrictBuild = [bool] $Strict
if ($Insecure) { Write-Warning 'TLS verification is off (-Insecure). Use -CaBundle for anything but a dev box.' }

# Shared settings can come from the config file; parameters given on the command line win.
$instances = @()
if ($PSCmdlet.ParameterSetName -eq 'Config') {
    $cfg = Import-PowerShellDataFile -LiteralPath (Resolve-FullPath $Config)
    if (-not $cfg.ContainsKey('Instances') -or @($cfg.Instances).Count -eq 0) { throw "$Config lists no Instances." }
    $instances = @($cfg.Instances)
    $configDir = Split-Path -Parent (Resolve-FullPath $Config)
    foreach ($key in 'Annotations', 'AnnotationRepo', 'AnnotationBranch', 'RedactProfile', 'Out') {
        if ($cfg.ContainsKey($key) -and -not $PSBoundParameters.ContainsKey($key)) {
            $value = $cfg[$key]
            if ($key -in 'Annotations', 'Out' -and -not [IO.Path]::IsPathRooted($value)) { $value = Join-Path $configDir $value }
            Set-Variable -Name $key -Value $value
        }
    }
} else {
    $single = @{ Instance = $Instance; Url = $Url; Name = $InstanceName; WebUrl = $WebUrl; AcsStack = $AcsStack
                 Products = $Products; DeploymentAppsDir = $DeploymentAppsDir; TokenEnv = $TokenEnv
                 Fields = [bool] $Fields; ExtraArgs = $ExtraArgs }
    $instances = @($single)
}
$ids = @($instances | ForEach-Object { $_.Instance })
if (@($ids | Sort-Object -Unique).Count -ne $ids.Count) { throw "Instance ids must be unique: $($ids -join ', ')" }

if ($RedactProfile -eq 'public' -and -not $env:DELVECAT_REDACT_SALT) {
    throw 'The public profile needs DELVECAT_REDACT_SALT (a secret) so pseudonyms stay stable between builds.'
}

$Out = Resolve-FullPath $Out
if ($SingleFile -and $Out -notmatch '\.json$') { $Out = "$Out.json" }
$staging = "$Out.new"
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
$previous = $null
if (-not $NoPrevious -and (Test-Path -LiteralPath $Out)) { $previous = $Out }

$shared = @()
if ($Annotations) {
    $shared += @('--annotations', (Resolve-FullPath $Annotations))
    if ($AnnotationRepo) { $shared += @('--annotation-repo', $AnnotationRepo, '--annotation-branch', $AnnotationBranch) }
}
if ($RedactProfile -ne 'none') { $shared += @('--redact-profile', $RedactProfile) }
if ($previous) { $shared += @('--previous', $previous) }
if (-not $SingleFile) { $shared += '--shard' }

# --- tokens: only through the environment of the child process -------------------------

# Only instances read over REST need a token (a Url); the CLI reports one missing a Url.
$tokenNames = @($instances | Where-Object { $_.ContainsKey('Url') -and $_.Url } | ForEach-Object {
        if ($_.ContainsKey('TokenEnv') -and $_.TokenEnv) { $_.TokenEnv } else { 'DELVECAT_SPLUNK_TOKEN' }
    } | Sort-Object -Unique)
if (@($instances | Where-Object { $_.ContainsKey('AcsStack') -and $_.AcsStack }).Count) { $tokenNames += 'DELVECAT_ACS_TOKEN' }
$saved = @{}
foreach ($name in $tokenNames) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name)
    [Environment]::SetEnvironmentVariable($name, (Get-Secret $name "Token for $name"), 'Process')
}

# --- build ----------------------------------------------------------------------------

$parts = $null
try {
    if ($instances.Count -eq 1) {
        Write-Host "Building $($instances[0].Instance)..."
        Invoke-Ingest ((Get-InstanceArgs $instances[0] $staging) + $shared)
    } else {
        # Each instance on its own, unredacted and without annotations; the merge
        # links across instances, then annotates and redacts the result.
        $parts = Join-Path ([IO.Path]::GetTempPath()) ("delvecat-parts-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $parts | Out-Null
        $files = @()
        foreach ($i in $instances) {
            Write-Host "Building $($i.Instance)..."
            $target = Join-Path $parts "$($i.Instance).json"
            Invoke-Ingest (Get-InstanceArgs $i $target)
            $files += $target
        }
        Write-Host "Merging $($files.Count) instances..."
        $merge = @('merge') + $files + @('--out', $staging) + $shared
        if ($Strict -and $Annotations) { $merge += '--strict' }
        Invoke-Ingest $merge
    }

    # Replace the old catalog only now that the new one is complete.
    if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Recurse -Force }
    Move-Item -LiteralPath $staging -Destination $Out
    Write-Summary $Out
    Write-Host "Open it in DelveCat with 'Open folder' (or 'Open file'), or copy it to web\public\catalog and build the app."
}
finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    if ($parts -and (Test-Path -LiteralPath $parts)) { Remove-Item -LiteralPath $parts -Recurse -Force }
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
