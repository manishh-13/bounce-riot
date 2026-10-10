# Bounce Riot room service: AWS deployment

API Gateway WebSocket (`$connect`, `$disconnect`, `$default`; stage `prod`, AutoDeploy) -> one Lambda (nodejs22.x arm64, AWS SDK v3 from the runtime, no bundled dependencies) -> one on-demand DynamoDB table with TTL. The IAM role allows only Get/Put/Update/DeleteItem on that table, `execute-api:ManageConnections` on this API's `prod/POST|DELETE/@connections/*`, and log writes to its own 7-day log group. Nothing hardcodes an account ID or credentials; the AWS CLI's normal credential chain is used.

## Deploy your own room service

```
python3 infra/deploy.py --dry-run          # builds infra/generated-template.json + .artifacts/room-service.zip, no AWS calls
python3 infra/deploy.py                     # region ap-south-1, stack bounce-riot-room-service, asks for confirmation
node server/smoke.mjs "$(python3 -c 'import json;print(json.load(open("infra/deployment.json"))["url"])')"
```

Options: `--region`, `--stack`, `--profile`, `--origins` (default `https://manishh-13.github.io,http://localhost:4381,http://127.0.0.1:4381`), `--reserved-concurrency` (20; the script fails with guidance if the account's unreserved concurrency cannot cover it, and never drops the cap silently; 0 removes the ceiling), `--throttle-rate` (400), `--throttle-burst` (200), `--yes`.

What it does: `node infra/template.mjs` generates the template; `aws cloudformation deploy` deploys it (no S3, template under 51,200 bytes); `aws lambda update-function-code` uploads the handler zip; the URL is written to `infra/deployment.json` (gitignored).

Why there is a separate code upload: inline `ZipFile` code becomes a single CommonJS `index.js`, but the handler is three ES modules. So the stack ships a fail-closed placeholder (`503` on every route) and deploy.py replaces it. As a result the function code drifts from the template on purpose. Always deploy through deploy.py. A stack update alone never reverts the code unless the placeholder text changes. For a code-only update:

```
python3 infra/deploy.py --dry-run
aws lambda update-function-code --region ap-south-1 --function-name bounce-riot-room-service-room --zip-file fileb://.artifacts/room-service.zip
```

The zip is deterministic. Compare its base64 SHA-256 with `aws lambda get-function-configuration ... --query CodeSha256` to confirm the deployed code matches.

Teardown: `aws cloudformation delete-stack --region ap-south-1 --stack-name bounce-riot-room-service` (the table and logs are ephemeral and get deleted).

Limits and costs: see `server/README.md`. Throttles bound the rate, not the bill. Set an AWS Budget alert.
