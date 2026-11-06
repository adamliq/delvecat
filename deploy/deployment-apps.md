Sample deployment apps (in deployment-apps/) served by the dev Splunk acting as a Deployment Server
(mounted read-only at /opt/delvecat-deployment-apps; see docker-compose.yml and
deploy/seed_dev_splunk.py). `delvecat-ingest build --deployment-apps-dir` reads
the same folder to catalogue the inputs each app pushes to forwarders.
