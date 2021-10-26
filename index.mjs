import jwt from 'jsonwebtoken';
import md5 from 'md5';
import fs from 'fs/promises';
import { homedir } from 'os';
import fetch from 'node-fetch';

// issuerId and apiKey from https://appstoreconnect.apple.com/access/api
// p8 file was generated initially, and somebody stored it in ~/.appstoreconnect/private_keys (iTMSTransporter?)
export const api = async function AppStoreConnectApiFetcher({ issuerId, apiKey, privateKey,
    urlBase = "https://api.appstoreconnect.apple.com/v1",
    tokenExpiresInSeconds = 1200
} = {}) {
    if (!privateKey) privateKey = await fs.readFile(`${homedir()}/.appstoreconnect/private_keys/AuthKey_${apiKey}.p8`);

    function getBearerToken(issuerId, apiKey, privateKey) {
        const NOW = Math.round((new Date()).getTime() / 1000);

        const PAYLOAD = {
            'iss': issuerId,
            'exp': NOW + tokenExpiresInSeconds,
            'aud': 'appstoreconnect-v1'
        };

        const SIGN_OPTS = {
            'algorithm': 'ES256',
            'header': {
                'alg': 'ES256',
                'kid': apiKey,
                'typ': 'JWT'
            }
        };

        const bearerToken = jwt.sign(
            PAYLOAD,
            privateKey,
            SIGN_OPTS
        );

        return bearerToken;
    }

    const bearerToken = getBearerToken(issuerId, apiKey, privateKey);

    const authFetch = async function authFetch(url, options) {
        if (!options) options = {};
        if (!options.headers) options.headers = {};
        options.headers.Authorization = `Bearer ${bearerToken}`;
        // try-try-again; sometimes Apple rejects perfectly good bearer tokens
        let response;
        for (let i = 0; i < 5; i++) {
            response = await fetch(url, options);
            if (response.status != 401 && response.status != 429) return response;
        }
        return response;
    }

    async function fetchJson(url, options) {
        if (!/^https:\/\//.test(url)) url = `${urlBase}/${url}`;
        const response = await authFetch(url, options);
        const text = await response.text();
        const contentType = response.headers.get('content-type');
        const isJson = (contentType === 'application/json' || contentType === 'application/vnd.api+json');
        if (response.ok) {
            if (isJson) {
                return JSON.parse(text);
            } else {
                return text;
            }
        } else {
            if (isJson) {
                const error = new Error(text);
                error.data = JSON.parse(text);
                throw error;
            } else {
                throw new Error(text);
            }
        }
    }

    async function postJson(url, data, options) {
        return fetchJson(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data),
            ...options
        })
    }

    async function patchJson(url, data, options) {
        return postJson(url, data, { method: 'PATCH', ...options });
    }

    async function uploadAsset(assetData, buffer, maxTriesPerPart = 10) {
        const targetStart = 0;
        const sourceFileChecksum = md5(buffer);
        await Promise.all(assetData.attributes.uploadOperations.map(async (uploadOperation, i) => {
            const body = Buffer.alloc(uploadOperation.length);
            const sourceStart = uploadOperation.offset;
            const sourceEnd = uploadOperation.offset + uploadOperation.length;
            buffer.copy(body, targetStart, sourceStart, sourceEnd);
            const method = uploadOperation.method;
            const headers = {};
            for (const requestHeader of uploadOperation.requestHeaders) {
                headers[requestHeader.name] = requestHeader.value;
            }
            for (let tries = 1; tries <= maxTriesPerPart; tries++) {
                // https://developer.apple.com/documentation/appstoreconnectapi/uploading_assets_to_app_store_connect
                // The provided upload URLs are unauthenticated and time-limited.
                // You don’t need to supply a JWT; don’t share the URLs.
                const response = await fetch(uploadOperation.url, { method, headers, body });
                if (response.ok) {
                    break;
                } else {
                    const errorText = `Failed uploading chunk ${i} of ${assetData.data.type}/${assetData.data.id}: ` +
                        `${response.status} ${response.statusText} ${await response.text()}`;
                    // console.log(errorText);
                    if (tries >= maxTriesPerPart) {
                        throw new Error(errorText);
                    }
                }
            }
        }));
        await patchJson(`${assetData.type}/${assetData.id}`, {
            data: {
                type: assetData.type,
                id: assetData.id,
                attributes: {
                    uploaded: true,
                    sourceFileChecksum,
                }
            }
        });
    }

    async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    async function pollForUploadSuccess(assetUrl, logHeader = "", delayInMilliseconds = 1000, maxTries = 60) {
        if (logHeader) logHeader += ' ';
        let tries = 0;
        while (true) {
            if (maxTries) {
                tries++;
                if (tries >= maxTries) throw new Error(`${logHeader}${assetUrl} upload state was ${state} after ${maxTries} tries`);
            }
            let assetData;
            try {
                assetData = await fetchJson(assetUrl);
            } catch (e) {
                if (e?.data?.errors?.[0]?.status == 500) {
                    console.log(`${logHeader}${assetUrl} 500 error`);
                    await sleep(delayInMilliseconds);
                    continue;
                }
            }
            const assetDeliveryState = assetData?.data?.attributes?.assetDeliveryState;
            const state = assetDeliveryState?.state;
            if (!state) throw new Error(`${logHeader}${assetUrl} couldn't find data.attributes.assetDeliveryState.state: ${JSON.stringify(assetData)}`);
            if (state === 'COMPLETE') return;
            if (state === 'FAILED') throw new Error(`${logHeader}${assetUrl} upload failed: ${JSON.stringify(assetDeliveryState.errors)}`);
            //console.log(`${logHeader} ${state} ${assetUrl}`);
            await sleep(delayInMilliseconds);
        }
    }

    return { fetch: authFetch, fetchJson, postJson, patchJson, uploadAsset, pollForUploadSuccess };
}
