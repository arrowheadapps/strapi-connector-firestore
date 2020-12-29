import * as _ from 'lodash';
import { FieldValue } from '@google-cloud/firestore';

export function mapToFlattenedDoc(id: string, data: any, merge: boolean) {
  if (typeof data !== 'object') {
    throw new Error(`Invalid data provided to Firestore. It must be an object but it was: ${JSON.stringify(data)}`);
  }
  
  if (!data || FieldValue.delete().isEqual(data)) {
    data = {
      [id]: FieldValue.delete(),
    };
  } else {
    if (merge) {
      // Flatten into key-value pairs to merge the fields
      data = _.toPairs(data).reduce((d, [path, value]) => {
        d[`${id}.${path}`] = value;
        return d;
      }, {});
    } else {
      data = { [id]: data };
    }
  }

  return data;
}
