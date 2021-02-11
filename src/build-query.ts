import * as _ from 'lodash';
import { convertRestQueryParams } from 'strapi-utils';
import { FieldPath } from '@google-cloud/firestore';
import { EmptyQueryError } from './utils/convert-where';
import { StatusError } from './utils/status-error';
import { buildPrefixQuery } from './utils/prefix-query';
import type { Queryable } from './db/queryable-collection';
import type { StrapiAttributeType, StrapiFilter, StrapiWhereFilter } from './types';
import type { FirestoreConnectorModel } from './model';
import type { Reference } from './db/reference';

export interface QueryArgs<T extends object> {
  model: FirestoreConnectorModel<T>
  params: any
  allowSearch?: boolean
}

export function buildQuery<T extends object>(query: Queryable<T>, { model, params, allowSearch }: QueryArgs<T>): Queryable<T> | Reference<T>[] | null {
  const isSearch = allowSearch && params._q;
  const { where, limit, sort, start }: StrapiFilter = convertRestQueryParams(params);

  try {
    if (isSearch) {
      query = buildSearchQuery(model, params._q, query);
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
    for (let { field, operator, value } of (where || [])) {
      if (operator === 'or') {
        query = query.whereAny(_.castArray(value || []));
        continue;
      }

      if (!field) {
        throw new StatusError(`Query field must not be empty, received: ${JSON.stringify(field)}.`, 404);
      }

      query = query.where(field, operator, value);
    }

    for (const { field, order } of (sort || [])) {
      if (field === model.primaryKey) {
        if (isSearch || 
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

    if (start && (start > 0)) {
      query = query.offset(start);
    }

    if (limit && (limit > 1)) {
      query = query.limit(limit);
    }

    return query;
  } catch (err) {
    if (err instanceof EmptyQueryError)
      return null;
    else
      throw err;
  }
}

function buildSearchQuery<T extends object>(model: FirestoreConnectorModel<T>, value: any, query: Queryable<T>) {

  if (model.options.searchAttribute) {
    const field = model.options.searchAttribute;
    const type: StrapiAttributeType | undefined = (field === model.primaryKey)
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
        return query.where(field, 'eq', value);

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
          .where(field, 'gte', gte)
          .where(field, 'lt', lt);
        
      default:
        throw new StatusError(`Search attribute "${field}" is an of an unsupported type`, 404);
    }

  } else {

    // Build a manual implementation of fully-featured search
    const filters: StrapiWhereFilter[] = [];

    if (value != null) {
      filters.push({ field: model.primaryKey, operator: 'containss', value });
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
            filters.push({ field, operator: 'eq', value });
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
            filters.push({ field, operator: 'contains', value });
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

    return query.whereAny(filters);
  }
};