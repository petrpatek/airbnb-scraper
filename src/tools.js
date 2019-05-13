const Apify = require('apify');
const camelcaseKeysRecursive = require('camelcase-keys-recursive');
const querystring = require('querystring');

const { utils: { log } } = Apify;
const { gerHomeListings, callForReviews } = require('./api');

const {
    HEADERS,
    HISTOGRAM_ITEMS_COUNT,
    MAX_PRICE,
    MIN_PRICE,
    MIN_LIMIT,
    MAX_LIMIT,
} = require('./constants');

async function enqueueListingsFromSection(results, requestQueue, minPrice, maxPrice) {
    for (const { listing } of results) {
        await requestQueue.addRequest({
            url: `https://api.airbnb.com/v2/pdp_listing_details/${listing.id}?_format=for_native`,
            headers: HEADERS,
            userData: {
                isHomeDetail: true,
                minPrice,
                maxPrice,
                id: listing.id,
            },
        });
    }
}

function randomDelay(minimum = 200, maximum = 600) {
    const min = Math.ceil(minimum);
    const max = Math.floor(maximum);
    return Apify.utils.sleep(Math.floor(Math.random() * (max - min + 1)) + min);
}

async function getListingsSection(locationId, minPrice, maxPrice, requestQueue, getRequest) {
    const pageSize = MAX_LIMIT;
    let offset = 0;
    let data = await gerHomeListings(locationId, getRequest, minPrice, maxPrice, pageSize, offset);
    const numberOfHomes = data.metadata.listings_count;
    const numberOfFetches = numberOfHomes / pageSize;
    await enqueueListingsFromSection(data.search_results, requestQueue, minPrice, maxPrice);

    for (let i = 0; i < numberOfFetches; i++) {
        offset += pageSize;
        await randomDelay();
        data = await gerHomeListings(locationId, getRequest, minPrice, maxPrice, pageSize, offset);
        await enqueueListingsFromSection(data.search_results, requestQueue, minPrice, maxPrice);
    }
}

async function addListings(query, requestQueue) {
    const intervalSize = MAX_PRICE / HISTOGRAM_ITEMS_COUNT;
    let pivotStart = MIN_PRICE;
    let pivotEnd = intervalSize;
    for (let i = 0; i < HISTOGRAM_ITEMS_COUNT; i++) {
        const queryString = {
            location: query,
            price_min: pivotStart,
            price_max: pivotEnd,
        };
        const url = `https://api.airbnb.com/v2/search_results?${querystring.stringify(queryString)}`;

        log.info(`Adding initial pivoting url: ${url}`);

        await requestQueue.addRequest({
            url,
            userData: {
                isPivoting: true,
                pivotStart,
                pivotEnd,
                query,
            },
        });

        pivotStart += intervalSize;
        pivotEnd += intervalSize;
    }
}

async function pivot(request, requestQueue, getRequest) {
    const { pivotStart, pivotEnd, query } = request.userData;
    const data = await getRequest(request.url);
    const listingCount = data.metadata.listings_count;

    if (listingCount === 0) {
        return;
    }

    if (listingCount > 1000 && (pivotEnd - pivotStart > 1)) {
        const intervalMiddle = Math.ceil((pivotEnd + pivotStart) / 2);
        const firstHalfQuery = {
            location: query,
            price_min: pivotStart,
            price_max: intervalMiddle,
            _limit: MIN_LIMIT,
        };
        const firstHalfUrl = `http://api.airbnb.com/v2/search_results?${querystring.stringify(firstHalfQuery)}`;

        await requestQueue.addRequest({
            url: firstHalfUrl,
            userData: {
                pivotStart,
                pivotEnd: intervalMiddle,
                isPivoting: true,
                query,
            },
        });

        const secondHalfQuery = {
            location: query,
            price_min: intervalMiddle,
            price_max: pivotEnd,
            _limit: MIN_LIMIT,
        };
        const secondHalfUrl = `http://api.airbnb.com/v2/search_results?${querystring.stringify(secondHalfQuery)}`;

        await requestQueue.addRequest({
            url: secondHalfUrl,
            userData: {
                pivotStart: intervalMiddle,
                pivotEnd,
                isPivoting: true,
                query,
            } });
    } else {
        log.info(`Getting listings for start: ${pivotStart} end: ${pivotEnd}`);
        await getListingsSection(query, pivotStart, pivotEnd, requestQueue, getRequest);
    }
}

async function getReviews(listingId, getRequest) {
    const results = [];
    const pageSize = MAX_LIMIT;
    let offset = 0;
    let data = await callForReviews(listingId, getRequest, pageSize, offset);
    data.reviews.forEach(rev => results.push(camelcaseKeysRecursive(rev)));
    const numberOfHomes = data.metadata.reviews_count;
    const numberOfFetches = numberOfHomes / pageSize;

    for (let i = 0; i < numberOfFetches; i++) {
        offset += pageSize;
        await randomDelay();
        data = await callForReviews(listingId, getRequest, pageSize, offset);
        data.reviews.forEach(rev => results.push(camelcaseKeysRecursive(rev)));
    }
    return results;
}


module.exports = {
    addListings,
    pivot,
    getReviews,
};
