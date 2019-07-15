const Apify = require('apify');
const camelcaseKeysRecursive = require('camelcase-keys-recursive');
const querystring = require('querystring');
const moment = require('moment');
const currencies = require('./currencyCodes.json');

const { utils: { log } } = Apify;
const { getHomeListings, callForReviews } = require('./api');
const {
    HEADERS,
    HISTOGRAM_ITEMS_COUNT,
    DEFAULT_MAX_PRICE,
    DEFAULT_MIN_PRICE,
    MIN_LIMIT,
    MAX_LIMIT,
    DATE_FORMAT,
} = require('./constants');

async function enqueueListingsFromSection(results, requestQueue, minPrice, maxPrice) {
    for (const { listing } of results) {
        await enqueueDetailLink(listing.id, requestQueue, minPrice, maxPrice);
    }
}

function enqueueDetailLink(id, requestQueue, minPrice, maxPrice) {
    log.debug(`Enquing home with id: ${id}`);
    return requestQueue.addRequest({
        url: `https://api.airbnb.com/v2/pdp_listing_details/${id}?_format=for_native`,
        headers: HEADERS,
        userData: {
            isHomeDetail: true,
            minPrice,
            maxPrice,
            id,
        },
    });
}

function randomDelay(minimum = 100, maximum = 200) {
    const min = Math.ceil(minimum);
    const max = Math.floor(maximum);
    return Apify.utils.sleep(Math.floor(Math.random() * (max - min + 1)) + min);
}

async function getListingsSection(locationId, minPrice, maxPrice, requestQueue, getRequest, checkIn, checkOut) {
    const pageSize = MAX_LIMIT;
    let offset = 0;
    let data = await getHomeListings(locationId, getRequest, minPrice, maxPrice, pageSize, offset, checkIn, checkOut);
    const numberOfHomes = data.metadata.listings_count;
    const numberOfFetches = numberOfHomes / pageSize;
    await enqueueListingsFromSection(data.search_results, requestQueue, minPrice, maxPrice);

    for (let i = 0; i < numberOfFetches; i++) {
        offset += pageSize;
        await randomDelay();
        data = await getHomeListings(locationId, getRequest, minPrice, maxPrice, pageSize, offset, checkIn, checkOut);
        await enqueueListingsFromSection(data.search_results, requestQueue, minPrice, maxPrice);
    }
}

async function addListings(query, requestQueue, minPrice = DEFAULT_MIN_PRICE, maxPrice = DEFAULT_MAX_PRICE, checkIn, checkOut) {
    const intervalSize = maxPrice / HISTOGRAM_ITEMS_COUNT;
    let pivotStart = minPrice;
    let pivotEnd = intervalSize;
    for (let i = 0; i < HISTOGRAM_ITEMS_COUNT; i++) {
        const queryString = {
            location: query,
            price_min: pivotStart,
            price_max: pivotEnd,
            _limit: MIN_LIMIT,
        };

        if (checkIn) {
            queryString.checkin = checkIn;
        }

        if (checkOut) {
            queryString.checkout = checkOut;
        }

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

async function pivot(request, requestQueue, getRequest, checkIn, checkOut) {
    const { pivotStart, pivotEnd, query } = request.userData;
    const data = await getRequest(request.url);
    const listingCount = data.metadata.listings_count;

    log.debug(`Listings found: ${listingCount}`);

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

        if (checkIn) {
            firstHalfQuery.checkin = checkIn;
        }

        if (checkOut) {
            firstHalfQuery.checkout = checkOut;
        }

        const firstHalfUrl = `http://api.airbnb.com/v2/search_results?${querystring.stringify(firstHalfQuery)}`;
        log.debug(`First half url: ${firstHalfUrl}`);

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

        if (checkIn) {
            secondHalfQuery.checkin = checkIn;
        }

        if (checkOut) {
            secondHalfQuery.checkout = checkOut;
        }

        const secondHalfUrl = `http://api.airbnb.com/v2/search_results?${querystring.stringify(secondHalfQuery)}`;
        log.debug(`Second half url: ${secondHalfUrl}`);

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
        await getListingsSection(query, pivotStart, pivotEnd, requestQueue, getRequest, checkIn, checkOut);
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

function validateInput(input) {
    const validate = (inputKey, type = 'string') => {
        const value = input[inputKey];
        if (value) {
            if (typeof value !== type) { //eslint-disable-line
                throw new Error(`Value of ${inputKey} should be ${type}`);
            }
        }
    };
    const checkDate = (date) => {
        if (date) {
            const match = moment(date, DATE_FORMAT).format(DATE_FORMAT) === date;
            if (!match) {
                throw new Error(`Date should be in format ${DATE_FORMAT}`);
            }
        }
    };
    // check required field
    if (!input.locationQuery && input.startUrls.length <= 0) {
        throw new Error("At least one of the 'locationQuery' or 'startUrls' should be present.");
    }

    // check correct types
    validate(input.locationQuery, 'string');
    validate(input.minPrice, 'number');
    validate(input.maxPrice, 'number');
    validate(input.maxReviews, 'number');
    validate(input.includeReviews, 'boolean');

    // check date
    checkDate(input.checkIn);
    checkDate(input.checkOut);

    if (input.currency) {
        if (!currencies.find(curr => curr === input.currency)) {
            throw new Error('Currency should be in ISO format');
        }
    }

    if (input.startUrls) {
        if (!Array.isArray(input.startUrls)) {
            throw new Error('startUrls should be an array');
        }
        input.startUrls.forEach((url) => {
            if (!url.url.includes('airbnb')) {
                throw new Error('Start url should be an airbnb');
            }
        });
    }
}

module.exports = {
    addListings,
    pivot,
    getReviews,
    validateInput,
    enqueueDetailLink,
};
