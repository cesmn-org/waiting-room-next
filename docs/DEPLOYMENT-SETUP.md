# Deployment setup

The repository deploys automatically to Cloudflare Workers through GitHub Actions when a commit is pushed to `main`. The workflow is `.github/workflows/deploy.yml`.

## One-time manual setup

### 1. Create or choose the Cloudflare account

Create the Cloudflare account that will own the Worker and Durable Object. Copy the account ID from the Cloudflare dashboard.

### 2. Create a scoped Cloudflare API token

In **Cloudflare dashboard → Account API Tokens**, create a token using the custom **Edit Cloudflare Workers** policy, scoped to this account. Do not use the global API key.

The token is used only by GitHub Actions and should not be committed to the repository or placed in a local `.env` file tracked by Git.

### 3. Add GitHub repository secrets

In the GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret                  | Value                           |
| ----------------------- | ------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | The scoped Cloudflare API token |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID       |

### 4. Connect this directory to GitHub

Create or choose the GitHub repository, add it as the `origin` remote, commit the project, and push the `main` branch. The first push to `main` will run the deployment workflow.

## Automated by Wrangler

Once `wrangler.toml` and the application source are added, the deployment workflow can automate:

- Worker deployment
- Durable Object binding and migrations declared in `wrangler.toml`
- Static asset deployment declared in `wrangler.toml`
- Worker version/deployment creation

No Cloudflare login is needed in GitHub Actions.

## Still requires manual Cloudflare configuration

These items are intentionally outside the first deployment workflow:

- Cloudflare Access application and policies for `/host`, `/intake`, and `/admin`
- The public TV display URL/domain and any short-code provisioning policy
- DNS/custom-domain setup, if we use a domain instead of the `workers.dev` hostname
- Any production environment variables or secrets that are not yet defined by the application
- Choosing the Cloudflare account and deployment name

Cloudflare Access can later be managed through Cloudflare's API or Terraform, but it requires decisions about the domain, identity provider, allowed users/groups, and policy rules first.
