
export function findComponentByGlobalId(globalId) {
  return Object.values(strapi.components).find(
    compo => compo.globalId === globalId
  );
};
