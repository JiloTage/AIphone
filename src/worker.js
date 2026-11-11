import models from '../config/models.json';
import systemPrompt from '../prompts/system.txt';
import transcriptionPrompt from '../prompts/transcription.txt';
import { handleRequest } from './api.js';

export default {
  fetch(request, env) {
    return handleRequest(request, env, { models, systemPrompt, transcriptionPrompt });
  },
};
