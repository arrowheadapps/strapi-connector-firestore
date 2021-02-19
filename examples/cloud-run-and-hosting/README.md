# Example Strapi project using Firestore, Cloud Run, Firebase Hosting, and Cloud Storage

- [x] The Strapi backend/API is deployed to Google Cloud Run
- [x] The Strapi front-end is deployed to Firebase Hosting
- [x] The backend is aliased at `/api` in Firebase Hosting (see `middlewares/api/index.js`, currently a patch to Strapi is required for this functionality)
- [x] The database is configured to use Firestore
- [x] The upload plugin is configured to use Google Cloud Storage

## Pre-requisites

- Install the Firebase CLI tools
- Install the `gcloud` CLI tools
- Optionally, install the Firestore emulator
- Optionally, install the Docker CLI tools

## How to use

1. Create a Firebase project.
2. Insert your Firebase/GCP project ID in `.firebaserc`.
3. Configure the admin JWT secret, as outlined [here](https://strapi.io/documentation/v3.x/migration-guide/migration-guide-3.0.x-to-3.1.x.html#_2-define-the-admin-jwt-token), but also apply it to the Cloud Run container using the GCP console. If this is a new container, you may need to deploy it first before assigning the environment variable, and the first deploy will fail to start without the environment variable. 

## Run locally

Start the Firestore emulator (in a separate shell)

`$ npm run emulator`

Start Strapi

`$ npm run develop`


## Deploy backend

Deploys only the files required to run the Strapi backend to a Cloud Run container:

1. Build the image (two options)
2. Deploy to Cloud Run (excluding the front-end files)

> NOTE: The example package.json includes scripts to automate deployment. You can try running `$ npm run deploy:backend`

**Build using Docker**

`$ docker build . --tag gcr.io/{PROJECT_ID}/api-admin`

`$ docker push us.gcr.io/{PROJECT_ID}/api-admin`


**Build using `gcloud`**

`$ gcloud builds submit --tag us.gcr.io/{PROJECT-ID}/api-admin`


**Deploy to Cloud Run**

`$ gcloud run deploy api-admin --image us.gcr.io/{PROJECT-ID}/api-admin --project {PROJECT_ID} --platform managed --region us-central1 --allow-unauthenticated`



## Deploy front-end

Deploys a production build of the Strapi front-end to to Firebase Hosting. 

1. Build the front-end
2. Deploy to Firebase Hosting (only the contents of `./build/`)

> NOTE: The example package.json includes scripts to automate deployment. You can try running `$ npm run deploy:frontend`

`$ npm run build:prod`

`$ firebase deploy --only hosting`
