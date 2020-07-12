# Example Strapi project using Firestore, Cloud Run, Firebase Hosting, and Cloud Storage

- [x] The Strapi backend/API is deployed to Google Cloud Run
- [x] The Strapi front-end is deployed to Firebase Hosting
- [x] The database is configured to use Firestore
- [x] The upload plugin is configured to use Google Cloud Storage

## Pre-requisites

- Install the Firebase CLI tools
- Install the Firestore emulator
- Install the `gcloud` CLI tools
- Optionally, install the Docker CLI tools

## How to use

1. Create a Firebase project.
2. Insert your Firebase/GCP project ID at `{PROJECT_ID}` in `./config/plugins.js` and `.firebaserc`.
3. Create and deploy a Cloud Run service called `api-admin` using the [Google Cloud Platform Console](https://console.cloud.google.com/run). You can use any image to begin with, we just need to get the URL to the Cloud Run service first.
4. Insert the URL of the Cloud Run service at `{YOUR_CLOUD_RUN_URL}` in `./config/server.js`.

## Run locally

Start the Firestore emulator (in a separate shell)

`$ npm run emulator`

Start Strapi

`$ npm run develop`


## Deploy backend

Deploys only the files required to run the Strapi backend to a Cloud Run container:

1. Build the image (two options)
2. Deploy to Cloud Run (excluding the front-end files)

**Build using Docker**

`$ docker build . --tag gcr.io/{PROJECT_ID}/api-admin`

`$ docker push gcr.io/{PROJECT_ID}/api-admin`


**Build using `gcloud`**

`$ gcloud builds submit --tag gcr.io/{PROJECT-ID}/api-admin`


**Deploy to Cloud Run**

`$ gcloud run deploy --image gcr.io/PROJECT-ID/api-admin --project {PROJECT_ID} --platform managed --region us-central1 --allow-unauthenticated`



## Deploy front-end

Deploys a production build of the Strapi front-end to to Firebase Hosting. 

1. Build the front-end
2. Deploy to Firebase Hosting (only the contents of `./build/`)

`$ npm run build:prod`

`$ firebase deploy --only hosting`
