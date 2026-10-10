#!/usr/bin/env python3
"""Deploy the Bounce Riot room service with the AWS CLI already configured in your shell.

Steps: generate the CloudFormation template (infra/template.mjs), deploy the stack, upload the
handler zip (server/*.mjs, AWS SDK v3 comes from the nodejs22.x runtime), write infra/deployment.json.
Use --dry-run to build the template and zip without calling AWS.
"""
from __future__ import annotations

import argparse
import io
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_OUT = ROOT / "infra" / "generated-template.json"
DEPLOYMENT_OUT = ROOT / "infra" / "deployment.json"
ZIP_OUT = ROOT / ".artifacts" / "room-service.zip"
HANDLER_FILES = {"index.mjs": "server/lambda.mjs", "hub.mjs": "server/hub.mjs", "dynamo-store.mjs": "server/dynamo-store.mjs"}
# Lambda refuses to reserve concurrency that would leave less than this unreserved in the account.
MIN_UNRESERVED = 100
PROD_ORIGINS = "https://manishh-13.github.io,http://localhost:4381,http://127.0.0.1:4381"


def run(cmd: list[str], capture: bool = True, allow_fail: bool = False) -> str | None:
    print("+ " + " ".join(cmd), flush=True)
    result = subprocess.run(cmd, check=False, text=True, stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.DEVNULL if allow_fail else None)
    if result.returncode != 0:
        if allow_fail:
            return None
        sys.exit(f"command failed ({result.returncode}): {cmd[0]} {cmd[1] if len(cmd) > 1 else ''}")
    return result.stdout or ""


def aws(args: argparse.Namespace, *cmd: str, capture: bool = True, allow_fail: bool = False) -> str | None:
    base = ["aws", "--region", args.region]
    if args.profile:
        base += ["--profile", args.profile]
    return run(base + list(cmd), capture, allow_fail)


def build_template() -> None:
    node = shutil.which("node")
    if not node:
        sys.exit("node is required to generate the template")
    run([node, str(ROOT / "infra" / "template.mjs"), str(TEMPLATE_OUT)])


def build_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, src in HANDLER_FILES.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, (ROOT / src).read_bytes())
    ZIP_OUT.parent.mkdir(parents=True, exist_ok=True)
    ZIP_OUT.write_bytes(buf.getvalue())
    return buf.getvalue()


def check_concurrency(args: argparse.Namespace) -> None:
    if not args.reserved_concurrency:
        return
    settings = json.loads(aws(args, "lambda", "get-account-settings", "--output", "json"))
    unreserved = int(settings["AccountLimit"]["UnreservedConcurrentExecutions"])
    # On a redeploy this function's own reservation is already excluded from the unreserved pool.
    current = aws(args, "lambda", "get-function-concurrency", "--function-name", f"{args.stack}-room",
                  "--output", "json", allow_fail=True)
    already = int(json.loads(current).get("ReservedConcurrentExecutions") or 0) if current else 0
    if unreserved + already - args.reserved_concurrency < MIN_UNRESERVED:
        sys.exit(
            f"cannot reserve {args.reserved_concurrency}: account has {unreserved} unreserved concurrency "
            f"(+{already} already reserved by this function) and Lambda keeps {MIN_UNRESERVED} unreserved.\n"
            "Request a Lambda concurrent executions increase in Service Quotas, or pass a smaller "
            "--reserved-concurrency. Passing 0 removes the concurrency ceiling entirely."
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--region", default="ap-south-1")
    parser.add_argument("--stack", default="bounce-riot-room-service")
    parser.add_argument("--profile", default=None, help="AWS CLI profile (default: CLI's normal resolution)")
    parser.add_argument("--origins", default=PROD_ORIGINS)
    parser.add_argument("--reserved-concurrency", type=int, default=20)
    parser.add_argument("--throttle-rate", type=int, default=400)
    parser.add_argument("--throttle-burst", type=int, default=200)
    parser.add_argument("--dry-run", action="store_true", help="build template + zip only, no AWS calls")
    parser.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = parser.parse_args()

    build_template()
    code = build_zip()
    print(f"template: {TEMPLATE_OUT.relative_to(ROOT)}  handler zip: {ZIP_OUT.relative_to(ROOT)} ({len(code)} bytes)")
    if args.dry_run:
        print("dry run: nothing deployed")
        return

    identity = json.loads(aws(args, "sts", "get-caller-identity", "--output", "json"))
    print(f"account {identity['Account']}  region {args.region}  stack {args.stack}")
    if not args.yes and input("Deploy? [y/N] ").strip().lower() != "y":
        sys.exit("aborted")

    check_concurrency(args)
    aws(
        args,
        "cloudformation", "deploy",
        "--stack-name", args.stack,
        "--template-file", str(TEMPLATE_OUT),
        "--capabilities", "CAPABILITY_IAM",
        "--no-fail-on-empty-changeset",
        "--tags", "app=bounce-riot",
        "--parameter-overrides",
        f"AllowedOrigins={args.origins}",
        f"ReservedConcurrency={args.reserved_concurrency}",
        f"ThrottleRateLimit={args.throttle_rate}",
        f"ThrottleBurstLimit={args.throttle_burst}",
        capture=False,
    )
    stacks = json.loads(aws(args, "cloudformation", "describe-stacks", "--stack-name", args.stack, "--output", "json"))
    outputs = {o["OutputKey"]: o["OutputValue"] for o in stacks["Stacks"][0].get("Outputs", [])}

    aws(args, "lambda", "update-function-code", "--function-name", outputs["FunctionName"],
        "--zip-file", f"fileb://{ZIP_OUT}", "--output", "json")

    deployment = {"region": args.region, "stack": args.stack, "url": outputs["WebSocketUrl"]}
    DEPLOYMENT_OUT.write_text(json.dumps(deployment, indent=2) + "\n")
    print(f"deployed: {outputs['WebSocketUrl']}  (written to {DEPLOYMENT_OUT.relative_to(ROOT)})")
    print("the code update finishes within seconds; until then the placeholder rejects connections (503)")
    print(f"smoke test: node server/smoke.mjs {outputs['WebSocketUrl']}")


if __name__ == "__main__":
    main()
