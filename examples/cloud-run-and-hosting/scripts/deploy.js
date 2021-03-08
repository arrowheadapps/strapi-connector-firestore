const fs = require('fs-extra');
const execa = require('execa');


deploy().catch(err => console.error(err));

async function deploy() {
  // Load GCP project ID and name
  const { projects: { default: projectId } } = await fs.readJSON('.firebaserc');
  const { name } = await fs.readJSON('package.json')
  const tag = `us.gcr.io/${projectId}/${name}`;

  // Submit build to gcloud
  await execa.command(`gcloud builds submit --tag ${tag} --project ${projectId}`, { stdio: 'inherit' });

  // Deploy to Cloud Run
  await execa.command(`gcloud run deploy ${name} --quiet --image ${tag} --project ${projectId} --update-env-vars GCP_PROJECT=${projectId} --platform managed --region us-central1 --allow-unauthenticated`, { stdio: 'inherit' });
}
