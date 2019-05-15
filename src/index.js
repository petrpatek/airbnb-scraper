const Apify = require('apify');
const rp = require('request-promise');
const camelcaseKeysRecursive = require('camelcase-keys-recursive');

const { utils: { log } } = Apify;
const { addListings, pivot, getReviews, validateInput, enqueueDetailLink } = require('./tools');

let tunnelAgentExceptionListener;
/**
 * The handler this function attaches overcomes a long standing bug in
 * the tunnel-agent NPM package that is used by the Request package internally.
 * The package throws an assertion error in a callback scope that cannot be
 * caught by conventional means and shuts down the running process.
 * @ignore
 */
const suppressTunnelAgentAssertError = () => {
    // Only set the handler if it's not already set.
    if (tunnelAgentExceptionListener) return;
    tunnelAgentExceptionListener = (err) => {
        try {
            const code = err.code === 'ERR_ASSERTION';
            const name = err.name === 'AssertionError [ERR_ASSERTION]';
            const operator = err.operator === '==';
            const value = err.expected === 0;
            const stack = err.stack.includes('/tunnel-agent/index.js');
            // If this passes, we can be reasonably sure that it's
            // the right error from tunnel-agent.
            if (code && name && operator && value && stack) {
                log.error('CheerioCrawler: Tunnel-Agent assertion error intercepted. The affected request will timeout.');
                return;
            }
        } catch (caughtError) {
            // Catch any exception resulting from the duck-typing
            // check. It only means that the error is not the one
            // we're looking for.
        }
        // Rethrow the original error if it's not a match.
        throw err;
    };
    process.on('uncaughtException', tunnelAgentExceptionListener);
};

Apify.main(async () => {
    suppressTunnelAgentAssertError();

    const input = await Apify.getInput();

    validateInput(input);

    const { currency, locationQuery, minPrice, maxPrice, checkIn, checkOut, startUrls, proxyConfiguration } = input;
    const getRequest = async (url) => {
        const getProxyUrl = () => {
            return Apify.getApifyProxyUrl({
                password: process.env.APIFY_PROXY_PASSWORD,
                groups: proxyConfiguration.apifyProxyGroups,
                session: `airbnb_${Math.floor(Math.random() * 100000000)}`,

            });
        };
        const getData = async (attempt = 0) => {
            let response;
            const proxyUrl = getProxyUrl();
            const options = {
                uri: url,
                headers: {
                    'x-airbnb-currency': currency,
                    'x-airbnb-api-key': process.env.API_KEY,
                },
                proxy: proxyUrl,
                json: true,
            };
            try {
                response = await rp(options);
            } catch (e) {
                log.exception(e.message, 'GetData error');
                if (e.statusCode === 429 && e.statusCode === 503) {
                    if (attempt >= 10) {
                        throw new Error(`Could not get data for: ${options.url}`);
                    }
                    response = await getData(attempt + 1);
                }
            }
            return response;
        };

        return getData();
    };

    const requestQueue = await Apify.openRequestQueue();

    // Add startUrls to the requestQueue
    if (startUrls && startUrls.length > 0) {
        for (const { url } of startUrls) {
            const id = url.slice(url.lastIndexOf('/') + 1, url.indexOf('?'));
            await enqueueDetailLink(id, requestQueue);
        }
    } else {
        await addListings(locationQuery, requestQueue, minPrice, maxPrice, checkIn, checkOut);
    }


    const crawler = new Apify.BasicCrawler({
        requestQueue,
        maxConcurrency: 25,
        minConcurrency: 10,
        handleRequestTimeoutSecs: 120,
        handleRequestFunction: async ({ request }) => {
            const { isHomeDetail, isPivoting } = request.userData;
            if (isPivoting) {
                log.info('Finding the interval with less than 1000 items');

                await pivot(request, requestQueue, getRequest);
            } else if (isHomeDetail) {
                log.info('Saving home detail');

                try {
                    const { pdp_listing_detail: detail } = await getRequest(request.url);
                    try {
                        detail.reviews = await getReviews(request.userData.id, getRequest);
                    } catch (e) {
                        log.exception(e, 'Could not get reviews');
                        detail.reviews = [];
                    }
                    await Apify.pushData(camelcaseKeysRecursive(detail));
                } catch (e) {
                    log.error('Could not get detail for home', e.message);
                }
            }
        },

        // This function is called if the page processing failed more than maxRequestRetries+1 times.
        handleFailedRequestFunction: async ({ request }) => {
            log.warning(`Request ${request.url} failed too many times`);
            await Apify.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
            });
        },
    });

    await crawler.run();
    process.removeListener('uncaughtException', tunnelAgentExceptionListener);
    tunnelAgentExceptionListener = null;
    log.info('Crawler finished.');
});
