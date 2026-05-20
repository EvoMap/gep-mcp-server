// Copyright 2024-2026 EvoMap
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Why a separate module rather than inline in remote.js:
// remote.js was already over the 500-LOC ceiling before this change; adding
// the helper there would deepen the ratchet violation. Extracting keeps the
// filter independently testable and lets runtime.js reuse it when local mode
// gains capsule-cost surfacing (currently capsule cost lives only on Hub
// matches, so runtime.js does not import this yet).

export function applyCostThresholds(response, { max_cost_tokens, max_cost_usd }) {
  const tokenCap = Number.isFinite(max_cost_tokens) ? max_cost_tokens : null;
  const usdCap = Number.isFinite(max_cost_usd) ? max_cost_usd : null;
  if (tokenCap === null && usdCap === null) return response;
  if (!response || !Array.isArray(response.matches)) return response;
  const matches = response.matches.filter(m => {
    if (tokenCap !== null && Number.isFinite(m?.cost_tokens) && m.cost_tokens > tokenCap) return false;
    if (usdCap !== null && Number.isFinite(m?.cost_usd) && m.cost_usd > usdCap) return false;
    return true;
  });
  return { ...response, matches };
}
