# AWS Lambda Deployment

Deployment architecture:

EventBridge
    |
    v
AWS Lambda
    |
    v
runHeartbeatCycle()
    |
    +--> Plaid
    |
    +--> CockroachDB Cloud
    |
    +--> anomaly detection

The deployment does not use:

- ECS
- Fargate
- RDS
- Terraform
- API Gateway
- S3
- Secrets Manager

The application database remains CockroachDB Cloud because it is part of
the CockroachDB sponsor integration.

---

## Prerequisites

Install/configure:

- AWS CLI
- Node.js
- npm
- esbuild through `npx`

Verify AWS credentials:

```bash
aws sts get-caller-identity