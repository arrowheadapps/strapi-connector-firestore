const waitRestart = require('./waitRestart');
const { stopStrapi } = require('./strapi');
const { cleanTestApp } = require('./testAppGenerator');

module.exports = ({ rq }) => {
  async function createComponent(data) {
    await rq({
      url: '/content-type-builder/components',
      method: 'POST',
      body: {
        component: {
          category: 'default',
          icon: 'default',
          connection: 'default',
          ...data,
        },
      },
    });

    await waitRestart();
  }

  async function deleteComponent(name) {
    await rq({
      url: `/content-type-builder/components/${name}`,
      method: 'DELETE',
    });

    await waitRestart();
  }

  function createContentTypeWithType(name, type, opts = {}) {
    return createContentType({
      connection: 'default',
      name,
      attributes: {
        field: {
          type,
          ...opts,
        },
      },
    });
  }

  async function createContentType(data, restart = true) {
    const result = await rq({
      url: '/content-type-builder/content-types',
      method: 'POST',
      body: {
        contentType: {
          connection: 'default',
          ...data,
        },
      },
    });

    if (result.body.errors) {
      console.error(result.body.errors);
    }

    if (restart) {
      await waitRestart();
    }
  }

  async function createContentTypes(models) {
    for (let model of models) {
      // Need to restart every time
      await createContentType(model, true);
    }

    await waitRestart();
  }

  async function deleteContentType() {
    // Just stop Strapi and clean the entire config
    // Don't bother to manually remove each content type
    await stopStrapi();
    await cleanTestApp();

    // await rq({
    //   url: `/content-type-builder/content-types/application::${model}.${model}`,
    //   method: 'DELETE',
    // });

    // await waitRestart();
  }

  async function deleteContentTypes() {
    await deleteContentType();

    // for (let model of models) {
    //   await deleteContentType(model);
    // }
  }

  return {
    createComponent,
    deleteComponent,

    createContentType,
    createContentTypes,
    createContentTypeWithType,
    deleteContentType,
    deleteContentTypes,
  };
};
