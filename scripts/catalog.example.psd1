# Example config for Build-Catalog.ps1 -Config. Copy it, edit, and run:
#   .\scripts\Build-Catalog.ps1 -Config .\catalog.psd1
# Each instance is built on its own, then merged. Relative paths (Out,
# Annotations) are relative to this file. No secrets here: tokens come from
# environment variables (or are asked for when the script runs).
@{
    Out              = 'catalog'          # folder, replaced only when a build succeeds
    Annotations      = '..\annotations'   # optional: owners, glossary, classifications...
    AnnotationRepo   = 'https://github.com/example/delvecat-annotations'
    AnnotationBranch = 'main'
    RedactProfile    = 'none'             # none | internal | public (public needs DELVECAT_REDACT_SALT)
    # PublishUrl     = 'https://sh.example.com:8089'  # store it in the DelveCat Splunk app
                                                     # (token in DELVECAT_PUBLISH_TOKEN)

    Instances = @(
        @{
            Instance = 'prod-sh'                         # stable id: do not change between builds
            Name     = 'Production search head'
            Url      = 'https://sh.example.com:8089'
            WebUrl   = 'https://sh.example.com'          # for "open in Splunk" links
            Fields   = $true                             # sample events to discover fields (slower)
        }
        @{
            Instance = 'prod-idx'
            Url      = 'https://idx1.example.com:8089'
            Only     = 'serverInfo,indexes'
            TokenEnv = 'DELVECAT_IDX_TOKEN'              # a different token for this instance
        }
        @{
            Instance          = 'prod-ds'
            Url               = 'https://ds.example.com:8089'
            Only              = 'serverInfo'
            Products          = 'deploymentServer'
            DeploymentAppsDir = '\\ds.example.com\splunk\etc\deployment-apps'
            NoUsage           = $true
        }
        # Splunk Cloud: ACS token in DELVECAT_ACS_TOKEN
        # @{
        #     Instance = 'cloud'
        #     Url      = 'https://acme.splunkcloud.com:8089'
        #     AcsStack = 'acme'
        # }
        # Anything else the build command takes goes in ExtraArgs, e.g. SOAR
        # (its token is read from the environment as usual):
        # @{
        #     Instance  = 'soar'
        #     ExtraArgs = @('--soar-url', 'https://soar.example.com')
        # }
    )
}
