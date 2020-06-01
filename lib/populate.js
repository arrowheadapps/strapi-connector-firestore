'use strict';

const { getDocRef, getModel } = require('./get-doc-ref');

/**
 * @param {FirebaseFirestore.CollectionReference} model
 * @param {FirebaseFirestore.DocumentSnapshot} docSnap 
 * @param {FirebaseFirestore.DocumentData} docData 
 */
function assignMeta(model, docSnap, docData) {
  docData[model.primaryKey] = docSnap.id;
  docData._createTime = docSnap.createTime && docSnap.createTime.toDate();
  docData._updateTime = docSnap.updateTime && docSnap.updateTime.toDate();

  // HACK:
  // I don't understand why, but it seems like the field 'id' is used rather than
  // the model.primaryKey (in this case '_id')
  // strapi-plugin-users-permissions/config/policies/permissions.js L78
  // I don't know if this is the intended behaviour or not
  docData.id = docData[model.primaryKey];
}

/**
 * @param {FirebaseFirestore.CollectionReference} model
 * @param {{ snap: FirebaseFirestore.QueryDocumentSnapshot, data: any }[]} docs 
 * @param {string[]} populateFields 
 * @param {FirebaseFirestore.Transaction} transaction 
 */
module.exports = async function populateDocs(model, docs, populateFields, transaction) {
  const docsData = [];
  /** @type {{ doc: FirebaseFirestore.DocumentReference, data: any, assign: (data: FirebaseFirestore.DocumentData) => void }[]} */
  const subDocs = [];

  await Promise.all(docs.map(doc => {
    const data = Object.assign({}, doc.data || doc.snap.data());
    if (!data) {
      throw new Error(`Document not found: ${doc.snap.path || doc.snap.ref.path}`);
    }

    assignMeta(model, doc.snap, data);
    docsData.push(data);

    return Promise.all(populateFields
      .map(async f => {
        const details = model._attributes[f];
        /** @type {FirebaseFirestore.CollectionReference} */
        const assocModel = getModel(details.model || details.collection, details.plugin);


        if (!data[f]) {
          if (!assocModel) {
            // TODO:
            // For example, this happens for polymorphic relations such as images
            // Can we just safely ignore this?
          } else {

            // For the following types of relations
            // The list is maintained in the related object not this one
            //  - oneToMany
            const q = assocModel.where(details.via, '==', doc.snap.ref || model.doc(doc.snap.id));
            const snaps = (await (transaction ? transaction.get(q) : q.get())).docs;
            data[f] = snaps.map(snap => {
              const d = snap.data();
              assignMeta(assocModel, snap, d);
              return d;
            });

          }
        } else if (Array.isArray(data[f])) {
          // one-to-many or many-to-many etc
          // Expects array of DocumentReference instances
          data[f].forEach(ref => {
            subDocs.push({
              doc: getDocRef(ref, assocModel),
              assign: (d) => data[f].push(d)
            });
          });
          // Erase doc references with empty array
          // waiting for the document data to be populated
          data[f] = [];
        } else {
          // one-to-one or many-to-one etc
          subDocs.push({
            doc: getDocRef(data[f], assocModel), // Expects instance of DocumentReference
            assign: (d) => data[f] = d
          });
        }
      }));
  }));

  // Get all the documents all at once
  const subDocsData = subDocs.length
    ? await (transaction || model.firestore).getAll(...subDocs.map(d => d.doc))
    : [];

  // Assign all the fetched data
  subDocsData.forEach((subDocSnap, i) => {
    const { assign } = subDocs[i];
    const data = subDocSnap.data();
    if (data) {
      assignMeta(model, subDocSnap, data);
      assign(data);
    } else {
      // How to handle a not found document
      throw new Error(`relation not found: ${subDocSnap.ref.path}`);
    }
  });

  return docsData;
};