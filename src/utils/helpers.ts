
export function findComponentByGlobalId(globalId: string) {
  return Object.values(strapi.components).find(
    compo => compo.globalId === globalId
  );
};
