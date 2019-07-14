const Apify = require('apify');
const camelcaseKeysRecursive = require('camelcase-keys-recursive');
const got = require('got');
const ProxyAgent = require('proxy-agent');

const { utils: { log } } = Apify;
const { addListings, pivot, getReviews, validateInput, enqueueDetailLink } = require('./tools');


Apify.main(async () => {
    const input = await Apify.getInput();

    validateInput(input);

    const {
        currency,
        locationQuery,
        minPrice,
        maxPrice,
        checkIn,
        checkOut,
        startUrls,
        proxyConfiguration,
        includeReviews,
    } = input;

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
            const agent = new ProxyAgent(getProxyUrl());
            const options = {
                url,
                headers: {
                    'x-airbnb-currency': currency,
                    'x-airbnb-api-key': process.env.API_KEY,
                },
                agent: {
                    https: agent,
                    http: agent,
                },
                json: true,
                retry: {
                    retries: 4,
                    errorCodes: ['EPROTO'],
                },
            };
            try {
                response = await got(options);
            } catch (e) {
                log.exception(e.message, 'GetData error');

                if (attempt >= 10) {
                    throw new Error(`Could not get data for: ${options.url}`);
                }

                if (e.statusCode === 429 && e.statusCode === 503) {
                    response = await getData(attempt + 1);
                }
            }
            return response.body;
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
        maxConcurrency: 100,
        minConcurrency: 50,
        handleRequestTimeoutSecs: 120,
        handleRequestFunction: async ({ request }) => {
            const { isHomeDetail, isPivoting } = request.userData;

            if (isPivoting) {
                log.info('Finding the interval with less than 1000 items');

                await pivot(request, requestQueue, getRequest);
            } else if (isHomeDetail) {
                try {
                    const { pdp_listing_detail: detail } = await getRequest(request.url);
                    log.info(`Saving home detail - ${detail.id}`);

                    detail.reviews = [];

                    if (includeReviews) {
                        try {
                            detail.reviews = await getReviews(request.userData.id, getRequest);
                        } catch (e) {
                            log.exception(e, 'Could not get reviews');
                        }
                    }

                    await Apify.pushData(camelcaseKeysRecursive(detail));
                } catch (e) {
                    log.error('Could not get detail for home', e.message);
                }
            }
        },

        handleFailedRequestFunction: async ({ request }) => {
            log.warning(`Request ${request.url} failed too many times`);
            await Apify.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
            });
        },
    });

    await crawler.run();
    log.info('Crawler finished.');
});
