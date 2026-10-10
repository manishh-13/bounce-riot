import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const STAGE = 'prod';

// Inline ZipFile code becomes a single CommonJS index.js, and the template body must stay under 51,200 bytes
// to deploy without an S3 bucket. The ESM handler spans three files, so the stack ships this fail-closed
// placeholder and deploy.py uploads server/*.mjs (no bundled dependencies) with update-function-code.
// Consequence: the function code drifts from the template; always deploy through deploy.py.
const PLACEHOLDER = "exports.handler = async () => ({ statusCode: 503 });\n";

const sub = (s) => ({ 'Fn::Sub': s });
const ref = (name) => ({ Ref: name });
const att = (name, attr) => ({ 'Fn::GetAtt': [name, attr] });

export function buildTemplate() {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'Bounce Riot room signaling and relay service (API Gateway WebSocket + Lambda + DynamoDB)',
    Parameters: {
      AllowedOrigins: {
        Type: 'String',
        Default: 'https://manishh-13.github.io,http://localhost:4381,http://127.0.0.1:4381',
        Description: 'Comma separated browser origins allowed to connect (local-dev would admit any localhost or private LAN page)',
      },
      ReservedConcurrency: {
        Type: 'Number',
        Default: 20,
        MinValue: 0,
        MaxValue: 200,
        Description: 'Reserved Lambda concurrency, which is also its ceiling; 0 omits the setting (unreserved, no ceiling)',
      },
      ThrottleRateLimit: { Type: 'Number', Default: 400, MinValue: 1, Description: 'Stage-wide steady messages per second' },
      ThrottleBurstLimit: { Type: 'Number', Default: 200, MinValue: 1, Description: 'Stage-wide burst messages' },
      ConnectRateLimit: { Type: 'Number', Default: 20, MinValue: 1, Description: 'Stage-wide new connections per second' },
      ConnectBurstLimit: { Type: 'Number', Default: 40, MinValue: 1, Description: 'Stage-wide burst of new connections' },
      MaxReadRequestUnits: { Type: 'Number', Default: 1000, MinValue: 1, Description: 'DynamoDB on-demand read ceiling per second' },
      MaxWriteRequestUnits: { Type: 'Number', Default: 200, MinValue: 1, Description: 'DynamoDB on-demand write ceiling per second' },
    },
    Conditions: {
      HasReservedConcurrency: { 'Fn::Not': [{ 'Fn::Equals': [ref('ReservedConcurrency'), 0] }] },
    },
    Resources: {
      Table: {
        Type: 'AWS::DynamoDB::Table',
        DeletionPolicy: 'Delete',
        UpdateReplacePolicy: 'Delete',
        Properties: {
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
          OnDemandThroughput: { MaxReadRequestUnits: ref('MaxReadRequestUnits'), MaxWriteRequestUnits: ref('MaxWriteRequestUnits') },
          SSESpecification: { SSEEnabled: true },
        },
      },
      LogGroup: {
        Type: 'AWS::Logs::LogGroup',
        DeletionPolicy: 'Delete',
        UpdateReplacePolicy: 'Delete',
        Properties: { LogGroupName: sub('/aws/lambda/${AWS::StackName}-room'), RetentionInDays: 7 },
      },
      Api: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: {
          Name: sub('${AWS::StackName}'),
          ProtocolType: 'WEBSOCKET',
          RouteSelectionExpression: '$request.body.action',
        },
      },
      FunctionRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
          },
          Policies: [
            {
              PolicyName: 'room-service',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
                    Resource: att('Table', 'Arn'),
                  },
                  {
                    Effect: 'Allow',
                    Action: 'execute-api:ManageConnections',
                    Resource: [
                      sub(`arn:\${AWS::Partition}:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${Api}/${STAGE}/POST/@connections/*`),
                      sub(`arn:\${AWS::Partition}:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${Api}/${STAGE}/DELETE/@connections/*`),
                    ],
                  },
                  {
                    Effect: 'Allow',
                    Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                    Resource: att('LogGroup', 'Arn'),
                  },
                ],
              },
            },
          ],
        },
      },
      Function: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: sub('${AWS::StackName}-room'),
          Description: 'Bounce Riot room service',
          Runtime: 'nodejs22.x',
          Architectures: ['arm64'],
          Handler: 'index.handler',
          MemorySize: 256,
          Timeout: 6,
          Role: att('FunctionRole', 'Arn'),
          ReservedConcurrentExecutions: { 'Fn::If': ['HasReservedConcurrency', ref('ReservedConcurrency'), ref('AWS::NoValue')] },
          LoggingConfig: { LogGroup: ref('LogGroup'), LogFormat: 'Text' },
          Environment: { Variables: { TABLE_NAME: ref('Table'), ALLOWED_ORIGINS: ref('AllowedOrigins'), ALLOW_MISSING_ORIGIN: 'false' } },
          Code: { ZipFile: PLACEHOLDER },
        },
      },
      InvokePermission: {
        Type: 'AWS::Lambda::Permission',
        Properties: {
          Action: 'lambda:InvokeFunction',
          FunctionName: ref('Function'),
          Principal: 'apigateway.amazonaws.com',
          SourceArn: sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*'),
        },
      },
      Integration: {
        Type: 'AWS::ApiGatewayV2::Integration',
        Properties: {
          ApiId: ref('Api'),
          IntegrationType: 'AWS_PROXY',
          IntegrationUri: sub('arn:${AWS::Partition}:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${Function.Arn}/invocations'),
        },
      },
      ...Object.fromEntries(
        [
          ['ConnectRoute', '$connect'],
          ['DisconnectRoute', '$disconnect'],
          ['DefaultRoute', '$default'],
        ].map(([name, routeKey]) => [
          name,
          {
            Type: 'AWS::ApiGatewayV2::Route',
            Properties: { ApiId: ref('Api'), RouteKey: routeKey, AuthorizationType: 'NONE', Target: sub('integrations/${Integration}') },
          },
        ]),
      ),
      Stage: {
        Type: 'AWS::ApiGatewayV2::Stage',
        DependsOn: ['ConnectRoute', 'DisconnectRoute', 'DefaultRoute'],
        Properties: {
          ApiId: ref('Api'),
          StageName: STAGE,
          AutoDeploy: true,
          DefaultRouteSettings: {
            ThrottlingRateLimit: ref('ThrottleRateLimit'),
            ThrottlingBurstLimit: ref('ThrottleBurstLimit'),
            DataTraceEnabled: false,
            DetailedMetricsEnabled: false,
          },
          RouteSettings: {
            $connect: { ThrottlingRateLimit: ref('ConnectRateLimit'), ThrottlingBurstLimit: ref('ConnectBurstLimit') },
          },
        },
      },
    },
    Outputs: {
      WebSocketUrl: { Value: sub(`wss://\${Api}.execute-api.\${AWS::Region}.\${AWS::URLSuffix}/${STAGE}`) },
      FunctionName: { Value: ref('Function') },
      TableName: { Value: ref('Table') },
      LogGroupName: { Value: ref('LogGroup') },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const json = `${JSON.stringify(buildTemplate(), null, 2)}\n`;
  if (process.argv[2]) writeFileSync(process.argv[2], json);
  else process.stdout.write(json);
}
