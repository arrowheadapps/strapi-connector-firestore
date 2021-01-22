'use strict';

const { clone, has, concat, isNil } = require('lodash/fp');
const qs = require('qs');
const request = require('supertest');
const { createUtils } = require('./utils');

const createAgent = (strapi, initialState = {}) => {
  const state = clone(initialState);
  const utils = createUtils(strapi);

  const agent = options => {
    const { method, url, body, formData, qs: queryString } = options;
    const supertestAgent = request.agent(strapi.server);

    if (has('token', state)) {
      supertestAgent.auth(state.token, { type: 'bearer' });
    }

    const fullUrl = concat(state.urlPrefix, url).join('');

    const rq = supertestAgent[method.toLowerCase()](fullUrl);

    if (queryString) {
      rq.query(qs.stringify(queryString));
    }

    if (body) {
      rq.send(body);
    }

    if (formData) {
      const attachFieldToRequest = field => rq.field(field, formData[field]);
      Object.keys(formData).forEach(attachFieldToRequest);
    }

    if (isNil(formData)) {
      rq.type('application/json');
    }

    return rq;
  };

  const createShorthandMethod = method => (url, options = {}) => {
    return agent({ ...options, url, method });
  };

  Object.assign(agent, {
    assignState(newState) {
      Object.assign(state, newState);
      return agent;
    },

    setURLPrefix(path) {
      return this.assignState({ urlPrefix: path });
    },

    setToken(token) {
      return this.assignState({ token });
    },

    setLoggedUser(loggedUser) {
      return this.assignState({ loggedUser });
    },

    getLoggedUser() {
      return state.loggedUser;
    },

    async login(userInfo) {
      const { token, user } = await utils.login(userInfo);

      this.setToken(token).setLoggedUser(user);

      return agent;
    },

    async registerOrLogin(userCredentials) {
      const { token, user } = await utils.registerOrLogin(userCredentials);

      this.setToken(token).setLoggedUser(user);

      return agent;
    },

    get: createShorthandMethod('GET'),
    post: createShorthandMethod('POST'),
    put: createShorthandMethod('PUT'),
    delete: createShorthandMethod('DELETE'),
  });

  return agent;
};

module.exports = {
  createAgent,
};
