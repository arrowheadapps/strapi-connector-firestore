import * as _ from 'lodash';
import { convertRestQueryParams } from 'strapi-utils';
import { FieldPath } from '@google-cloud/firestore';
import { EmptyQueryError } from './utils/convert-where';
import { StatusError } from './utils/status-error';
import { buildPrefixQuery } from './utils/prefix-query';
import type { Queryable } from './db/queryable-collection';
import type { AttributeType, Filter, Model, ModelData, OrClause } from 'strapi';
import type { Reference } from './db/reference';

export interface QueryArgs<T extends ModelData> {
  model: Model<T>
  params: any
  allowSearch?: boolean
}

export function buildQuery<T extends ModelData>(query: Queryable<T>, { model, params, allowSearch }: QueryArgs<T>): Queryable<T> | Reference<T>[] {

  // Capture the search term and remove it so it doesn't appear as filter
  const searchTerm = allowSearch ? params._q : undefined;
  delete params._q;

  const { where, limit, sort, start }: Filter = convertRestQueryParams(params);

  try {
    if (searchTerm !== undefined) {
      query = buildSearchQuery(model, searchTerm, query);
    }

    // Check for special case where querying for document IDs
    // In this case it is more effective to fetch the documents by id
    // because the "in" operator only supports ten arguments
    if (where && (where.length === 1)) {
      const [{ field, operator, value }] = where;
      if ((field === model.primaryKey) && ((operator === 'eq') || (operator === 'in'))) {
        return _.castArray(value || [])
          .slice(start || 0, (limit || -1) < 1 ? undefined : limit)
          .map(v => {
            if (!v || (typeof v !== 'string')) {
              throw new StatusError(`Argument for "${model.primaryKey}" must be an array of strings`, 400);
            }
            return model.db.doc(v)
          });
      }
    }

    // Apply filters
    for (const clause of (where || [])) {
      query = query.where(clause);
    }

    for (const { field, order } of (sort || [])) {
      if (field === model.primaryKey) {
        if ((searchTerm !== undefined) || 
          (where || []).some(w => w.field !== model.primaryKey)) {
          // Ignore sort by document ID when there are other filers
          // on fields other than the document ID
          // Document ID is the default sort for all queries 
          // And more often than not, it interferes with Firestore inequality filter
          // or indexing rules
        } else {
          query = query.orderBy(FieldPath.documentId() as any, order);
        }
      } else {
        query = query.orderBy(field, order);
      }
    };

    if (start! > 0) {
      query = query.offset(start!);
    }

    if (limit! > 0) {
      query = query.limit(limit!);
    }

    return query;
  } catch (err) {
    if (err instanceof EmptyQueryError)
      return [];
    else
      throw err;
  }
}

function buildSearchQuery<T extends ModelData>(model: Model<T>, value: any, query: Queryable<T>) {

  // Special case: empty query will match all entries
  if (value === '') {
    return query;
  }

  if (model.options.searchAttribute) {
    const field = model.options.searchAttribute;
    const type: AttributeType | undefined = (field === model.primaryKey)
      ? 'uid'
      : model.attributes[field].type;

    // Build a native implementation of primitive search
    switch (type) {
      case 'integer':
      case 'float':
      case 'decimal':
      case 'biginteger':
      case 'date':
      case 'time':
      case 'datetime':
      case 'timestamp':
      case 'json':
      case 'boolean':
        // Use equality operator 
        return query.where({ field, operator: 'eq', value });

      case 'string':
      case 'text':
      case 'richtext':
      case 'email':
      case 'enumeration':
      case 'uid':
      case 'password':
        // Use prefix operator
        const { gte, lt } = buildPrefixQuery(value);
        return query
          .where({ field, operator: 'gte', value: gte })
          .where({ field, operator: 'lt', value: lt });
        
      default:
        throw new StatusError(`Search attribute "${field}" is an of an unsupported type`, 400);
    }

  } else {

    // Build a manual implementation of fully-featured search
    const filters: OrClause['value'] = [];

    if (value != null) {
      filters.push([{ field: model.primaryKey, operator: 'eq', value }]);
    }

    for (const field of Object.keys(model.attributes)) {
      const attr = model.attributes[field];
      switch (attr.type) {
        case 'integer':
        case 'float':
        case 'decimal':
        case 'biginteger':
          try {
            // Use equality operator for numbers
            filters.push([{ field, operator: 'eq', value }]);
          } catch {
            // Ignore if the query can't be coerced to this type
          }
          break;

        case 'string':
        case 'text':
        case 'richtext':
        case 'email':
        case 'enumeration':
        case 'uid':
          try {
            // User contains operator for strings
            filters.push([{ field, operator: 'contains', value }]);
          } catch {
            // Ignore if the query can't be coerced to this type
          }
          break;

        case 'date':
        case 'time':
        case 'datetime':
        case 'timestamp':
        case 'json':
        case 'boolean':
        case 'password':
          // Explicitly don't search in these fields
          break;
          
        default:
          // Unsupported field type for search
          // Don't search in these fields
          break;
      }
    }

    // Apply OR filter
    return query.where({ operator: 'or', value: filters });
  }
};
