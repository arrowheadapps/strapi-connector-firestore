# Images can be manually built and deployed to GCP with the following commands
# > docker build . --tag gcr.io/${PROJECT_ID}/${IMAGE_NAME}
# > docker push gcr.io/${PROJECT_ID}/${IMAGE_NAME}

# To clean up afterwards, keeping the new image, run:
# > docker system prune -f

# To remove all images, run:
# > docker system prune -f -a


# Use the official lightweight Node.js 12 image.
# https://hub.docker.com/_/node
FROM node:12-alpine

# Create and change to the app directory.
WORKDIR /usr/src/app

# Copy application dependency manifests to the container image.
# A wildcard is used to ensure both package.json AND package-lock.json are copied.
# Copying this separately prevents re-running npm install on every code change.
COPY package*.json ./

# Install production dependencies.
RUN npm ci --only=production

# Copy local code to the container image.
COPY . ./

# Run the web service on container startup.
CMD [ "npm", "start" ]
