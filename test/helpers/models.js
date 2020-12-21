const { reloadStrapi } = require('./strapi');

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

    await reloadStrapi();
  }

  async function deleteComponent(name) {
    await rq({
      url: `/content-type-builder/components/${name}`,
      method: 'DELETE',
    });

    await reloadStrapi();
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
      await reloadStrapi();
    }
  }

  async function createContentTypes(models) {
    for (let model of models) {
      await createContentType(model);
    }
  }

  async function modifyContentType(data, restart = true) {
    const sanitizedData = { ...data };
    delete sanitizedData.editable;
    delete sanitizedData.restrictRelationsTo;

    await rq({
      url: `/content-type-builder/content-types/application::${sanitizedData.name}.${sanitizedData.name}`,
      method: 'PUT',
      body: {
        contentType: {
          connection: 'default',
          ...sanitizedData,
        },
      },
    });

    if (restart) {
      await reloadStrapi();
    }
  }

  async function modifyContentTypes(models) {
    for (let model of models) {
      await modifyContentType(model);
    }
  }

  async function getContentTypeSchema(model) {
    const { body } = await rq({
      url: '/content-type-builder/content-types',
      method: 'GET',
    });

    const contentType = body.data.find(ct => ct.uid === `application::${model}.${model}`);

    return (contentType || {}).schema;
  }

  async function deleteContentType(model) {
    // Don't do anything
    // Total cleanup will be handled be the afterAll
    // hook in Jest
  }

  async function deleteContentTypes(models) {
    // Don't do anything
    // Total cleanup will be handled be the afterAll
    // hook in Jest
  }

  async function cleanupContentTypes(models) {
    for (const model of models) {
      await cleanupContentType(model);
    }
  }

  async function cleanupContentType(model) {
    const { body } = await rq({
      url: `/content-manager/explorer/application::${model}.${model}`,
      method: 'GET',
    });

    if (Array.isArray(body) && body.length > 0) {
      const queryString = body.map((item, i) => `${i}=${item.id}`).join('&');

      await rq({
        url: `/content-manager/explorer/deleteAll/application::${model}.${model}?${queryString}`,
        method: 'DELETE',
      });
    }
  }

  return {
    createComponent,
    deleteComponent,
    createContentType,
    createContentTypes,
    createContentTypeWithType,
    deleteContentType,
    deleteContentTypes,
    modifyContentType,
    modifyContentTypes,
    getContentTypeSchema,
    cleanupContentType,
    cleanupContentTypes,
  };
};
