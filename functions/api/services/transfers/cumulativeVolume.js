const _ = require('lodash');
const moment = require('moment');
const {
  get_others_version_chain_ids,
} = require('./utils');
const {
  read,
} = require('../index');

module.exports = async (
  params = {},
) => {
  let response;

  const {
    sourceChain,
    destinationChain,
    asset,
  } = { ...params };
  let {
    fromTime,
    toTime,
    granularity,
    query,
  } = { ...params };

  granularity =
    granularity ||
    'month';

  const _query = _.cloneDeep(query);

  let must = [],
    should = [],
    must_not = [];

  if (sourceChain) {
    must.push({ match_phrase: { 'send.original_source_chain': sourceChain } });

    for (const id of get_others_version_chain_ids(sourceChain)) {
      must_not.push({ match_phrase: { 'send.original_source_chain': id } });
      must_not.push({ match_phrase: { 'send.source_chain': id } });
    }
  }

  if (destinationChain) {
    must.push({ match_phrase: { 'send.original_recipient_chain': destinationChain } });

    for (const id of get_others_version_chain_ids(destinationChain)) {
      must_not.push({ match_phrase: { 'send.original_destination_chain': id } });
      must_not.push({ match_phrase: { 'send.destination_chain': id } });
    }
  }

  if (asset) {
    must.push({ match_phrase: { 'send.denom': asset } });
  }

  if (fromTime) {
    fromTime = Number(fromTime) * 1000;
    toTime =
      toTime ?
        Number(toTime) * 1000 :
        moment()
          .valueOf();

    must.push({ range: { 'send.created_at.ms': { gte: fromTime, lte: toTime } } });
  }

  if (!query) {
    query = {
      bool: {
        must,
        should,
        must_not,
        minimum_should_match:
          should.length > 0 ?
            1 :
            0,
      },
    };
  }

  let _response =
    await read(
      'cross_chain_transfers',
      {
        ...query,
        bool: {
          ...query.bool,
          must:
            _.concat(
              query.bool?.must ||
              [],
              { exists: { field: 'confirm' } },
            ),
        },
      },
      {
        aggs: {
          cumulative_volume: {
            date_histogram: {
              field: `send.created_at.${granularity}`,
              calendar_interval: granularity,
            },
            aggs: {
              volume: {
                sum: {
                  field: 'send.value',
                },
              },
              cumulative_volume: {
                cumulative_sum: {
                  buckets_path: 'volume',
                },
              },
            },
          },
        },
        size: 0,
      },
    );

  const {
    aggs,
    total,
  } = { ..._response };
  const {
    cumulative_volume,
  } = { ...aggs };
  const {
    buckets,
  } = { ...cumulative_volume };

  if (buckets) {
    _response = {
      data:
        buckets
          .map(c => {
            const {
              key,
              volume,
              cumulative_volume,
              doc_count,
            } = { ...c };

            return {
              timestamp: key,
              volume:
                volume?.value ||
                0,
              cumulative_volume:
                cumulative_volume?.value ||
                0,
              num_txs: doc_count,
            };
          }),
      total,
    };

    response = {
      ..._response,
    };
  }

  return response;
};