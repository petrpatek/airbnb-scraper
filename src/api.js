const querystring = require('querystring');
const { MIN_PRICE, MAX_PRICE } = require('./constants');


function gerHomeListings(location, getRequest, priceMin = MIN_PRICE, priceMax = MAX_PRICE, limit = 20, offset = 0) {
    const queryString = {
        location,
        price_min: priceMin,
        price_max: priceMax,
        _limit: limit,
        _offset: offset,

    };
    return getRequest(
        `http://api.airbnb.com/v2/search_results?${querystring.stringify(queryString)}`,
    );
}

function callForReviews(listingId, getRequest, limit = 50, offset = 0) {
    const queryString = {
        _order: 'language_country',
        _limit: limit,
        _offset: offset,
        _format: 'for_mobile_client',
        role: 'all',
        listing_id: listingId,
    };
    return getRequest(
        `https://api.airbnb.com/v2/reviews?${querystring.stringify(queryString)}`,
    );
}

module.exports = {
    gerHomeListings,
    callForReviews,
};
