import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildTemplate } from '../infra/template.mjs';

const t = buildTemplate();
const r = t.Resources;
const json = JSON.stringify(t);

describe('CloudFormation template', () => {
  it('stays deployable without an S3 bucket and has no hardcoded account', () => {
    expect(JSON.stringify(t, null, 2).length).toBeLessThan(51_200);
    expect(json).not.toMatch(/\d{12}/);
    expect(json).not.toMatch(/AKIA|aws_secret/i);
  });

  it('uses Node 22, a fail-closed placeholder and a 7-day log group', () => {
    const fn = r.Function.Properties;
    expect(fn.Runtime).toBe('nodejs22.x');
    expect(fn.Handler).toBe('index.handler');
    expect(fn.Code.ZipFile).toContain('statusCode: 503');
    expect(fn.LoggingConfig.LogGroup).toEqual({ Ref: 'LogGroup' });
    expect(r.LogGroup.Properties.RetentionInDays).toBe(7);
    expect(fn.ReservedConcurrentExecutions['Fn::If'][0]).toBe('HasReservedConcurrency');
  });

  it('grants only item operations on the table and connection management on this stage', () => {
    const statements = r.FunctionRole.Properties.Policies.flatMap((p) => p.PolicyDocument.Statement);
    expect(statements.flatMap((s) => [s.Action].flat()).sort()).toEqual(
      ['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'execute-api:ManageConnections', 'logs:CreateLogStream', 'logs:PutLogEvents'].sort(),
    );
    expect(JSON.stringify(statements)).not.toContain('"*"');
    expect(statements[0].Resource).toEqual({ 'Fn::GetAtt': ['Table', 'Arn'] });
    for (const arn of statements[1].Resource) expect(arn['Fn::Sub']).toMatch(/\$\{Api\}\/prod\/(POST|DELETE)\/@connections\/\*$/);
  });

  it('uses on-demand DynamoDB with TTL and throughput ceilings', () => {
    const p = r.Table.Properties;
    expect(p.BillingMode).toBe('PAY_PER_REQUEST');
    expect(p.TimeToLiveSpecification).toEqual({ AttributeName: 'ttl', Enabled: true });
    expect(p.OnDemandThroughput).toBeDefined();
  });

  it('routes everything through $connect/$disconnect/$default with stage throttling', () => {
    const routes = Object.values(r).filter((x) => x.Type === 'AWS::ApiGatewayV2::Route').map((x) => x.Properties.RouteKey);
    expect(routes.sort()).toEqual(['$connect', '$default', '$disconnect']);
    const stage = r.Stage.Properties;
    expect(stage.AutoDeploy).toBe(true);
    expect(stage.DefaultRouteSettings).toMatchObject({ ThrottlingRateLimit: { Ref: 'ThrottleRateLimit' }, ThrottlingBurstLimit: { Ref: 'ThrottleBurstLimit' }, DataTraceEnabled: false });
    expect(stage.RouteSettings.$connect).toBeDefined();
    expect(t.Parameters.ThrottleRateLimit.Default).toBe(400);
    expect(t.Parameters.ThrottleBurstLimit.Default).toBe(200);
  });

  it('deploy.py zips every module the handler imports', () => {
    const deploy = readFileSync(new URL('../infra/deploy.py', import.meta.url), 'utf8');
    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      for (const [, dep] of src.matchAll(/from '\.\/([\w-]+\.mjs)'/g)) visit(dep);
    };
    visit('lambda.mjs');
    for (const file of seen) expect(deploy).toContain(`server/${file}`);
    expect(deploy).toContain('"index.mjs": "server/lambda.mjs"');
  });
});
