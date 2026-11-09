import { handleApi } from '../../src/index.js';

export const onRequest = ({ request, env }) => handleApi(request, env);
