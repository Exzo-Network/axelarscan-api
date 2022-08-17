const axios = require('axios');
const _ = require('lodash');
const moment = require('moment');
const config = require('config-yml');
const {
  get,
  read,
  write,
} = require('../../index');
const assets_price = require('../../assets-price');
const {
  sleep,
  equals_ignore_case,
  to_json,
  get_granularity,
  normalize_original_chain,
  normalize_chain,
  vote_types,
} = require('../../../utils');

const environment = process.env.ENVIRONMENT || config?.environment;

const evm_chains_data = require('../../../data')?.chains?.[environment]?.evm || [];
const cosmos_chains_data = require('../../../data')?.chains?.[environment]?.cosmos || [];
const chains_data = _.concat(
  evm_chains_data,
  cosmos_chains_data,
);
const axelarnet = chains_data.find(c => c?.id === 'axelarnet');
const cosmos_non_axelarnet_chains_data = cosmos_chains_data.filter(c => c?.id !== axelarnet.id);

const {
  endpoints,
  num_blocks_per_heartbeat,
  fraction_heartbeat_block,
} = { ...config?.[environment] };

module.exports = async (
  lcd_response = {},
) => {
  let response;

  const {
    tx_responses,
    txs,
  } = { ...lcd_response };

  if (tx_responses) {
    // Heartbeat
    try {
      const records = tx_responses
        .map((t, i) => {
          const {
            txhash,
            code,
            timestamp,
          } = { ...t };
          let {
            height,
          } = { ...t };
          const tx = txs?.[i];
          const {
            signatures,
          } = { ...tx };
          const {
            messages,
          } = { ...tx?.body };

          if (
            !code &&
            [
              'HeartBeatRequest',
            ].findIndex(s =>
              messages?.findIndex(m => m?.inner_message?.['@type']?.includes(s)) > -1
            ) > -1
          ) {
            height = Number(height);

            return {
              txhash,
              height,
              timestamp: moment(timestamp).valueOf(),
              period_height: height - (height % num_blocks_per_heartbeat) + fraction_heartbeat_block,
              signatures,
              sender: _.head(messages.map(m => m?.sender)),
              key_ids: _.uniq(messages.flatMap(m => m?.inner_message?.key_ids || [])),
            };
          }

          return null;
        })
        .filter(t => t?.sender);

      if (records.length > 0) {
        for (const record of records) {
          const {
            sender,
            period_height,
          } = { ...record };

          write(
            'heartbeats',
            `${sender}_${period_height}`,
            record,
          );
        }
      }
    } catch (error) {}

    // Link
    try {
      const records = tx_responses
        .filter(t =>
          !t?.code &&
          [
            'LinkRequest',
          ].findIndex(s =>
            t?.tx?.body?.messages?.findIndex(m => m?.['@type']?.includes(s)) > -1
          ) > -1
        ).map(async t => {
          const {
            txhash,
            code,
            timestamp,
            tx,
            logs,
          } = { ...t };
          let {
            height,
          } = { ...t };
          const {
            messages,
          } = { ...tx?.body };

          height = Number(height);

          const event = _.head(logs?.flatMap(l => l?.events?.filter(e => equals_ignore_case(e?.type, 'link'))));
          const {
            attributes,
          } = { ...event };

          const created_at = moment(timestamp).utc().valueOf();
          const sender_chain = attributes?.find(a => a?.key === 'sourceChain')?.value;
          const deposit_address = attributes?.find(a => a?.key === 'depositAddress')?.value;

          const record = {
            ..._.head(messages),
            txhash,
            height,
            created_at: get_granularity(created_at),
            sender_chain,
            deposit_address,
          };

          const {
            sender,
            chain,
            recipient_addr,
            asset,
            denom,
          } = { ...record };
          let {
            id,
            type,
            original_sender_chain,
            original_recipient_chain,
            sender_address,
            recipient_address,
            recipient_chain,
            price,
          } = { ...record };

          if (equals_ignore_case(sender_chain, axelarnet.id)) {
            const chain_data = cosmos_non_axelarnet_chains_data.find(c => sender_address?.startsWith(c?.prefix_address));
            const {
              id,
              overrides,
            } = { ...chain_data };

            sender_chain = _.last(Object.keys({ ...overrides })) || id || sender_chain;
          }

          id = deposit_address || txhash;
          type = record['@type']?.split('.')[0]?.replace('/', '');
          original_sender_chain = normalize_original_chain(sender_chain);
          original_recipient_chain = normalize_original_chain(recipient_chain);
          sender_address = sender;
          sender_chain = normalize_chain(
            cosmos_non_axelarnet_chains_data.find(c => sender_address?.startsWith(c?.prefix_address))?.id ||
            sender_chain ||
            chain
          );
          recipient_address = recipient_addr;
          recipient_chain = normalize_chain(recipient_chain);

          delete record['@type'];
          delete record.sender;
          delete record.chain;
          delete record.recipient_addr;

          if (
            typeof price !== 'number' &&
            (asset || denom)
          ) {
            let _response = await assets_price({
              chain: original_sender_chain,
              denom: asset || denom,
              timestamp: moment(timestamp).utc().valueOf(),
            });

            let _price = _.head(_response)?.price;
            if (_price) {
              price = _price;
            }
            else {
              _response = await get(
                'deposit_addresses',
                id,
              );

              _price = _.head(_response)?.price;
              if (_price) {
                price = _price;
              }
            }
          }

          return {
            ...record,
            id,
            type,
            original_sender_chain,
            original_recipient_chain,
            sender_chain,
            recipient_chain,
            sender_address,
            deposit_address,
            recipient_address,
            price,
          };
        });

      if (records.length > 0) {
        for (const record of records) {
          const {
            id,
          } = { ...record };

          write(
            'deposit_addresses',
            id,
            record,
          );
        }
      }
    } catch (error) {}

    // VoteConfirmDeposit & Vote
    try {
      const records = tx_responses
        .filter(t =>
          !t?.code &&
          vote_types.findIndex(s =>
            t?.tx?.body?.messages?.findIndex(m => _.last(m?.inner_message?.['@type']?.split('.'))?.replace('Request', '')?.includes(s)) > -1
          ) > -1
        ).flatMap(async t => {
          const {
            txhash,
            timestamp,
            tx,
            logs,
          } = { ...t };
          let {
            height,
          } = { ...t };
          const {
            messages,
          } = { ...tx?.body };

          height = Number(height);

          const _records = [];
          for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
              const {
              inner_message,
            } = { ...message };

            if (inner_message) {
              const type = _.last(inner_message['@type']?.split('.'))?.replace('Request', '');

              if (vote_types.includes(type)) {
                const created_at = moment(timestamp).utc().valueOf();

                const {
                  events,
                } = { ...logs?.[i] };

                const event = events?.find(e => equals_ignore_case(e?.type, 'depositConfirmation'));
                const vote_event = events?.find(e => e?.type?.includes('vote'));

                const {
                  attributes,
                } = { ...event };

                const poll_id = inner_message.poll_id ||
                  to_json(
                    inner_message.poll_key ||
                    attributes?.find(a => a?.key === 'poll')?.value ||
                    vote_event?.attributes?.find(a => a?.key === 'poll')?.value
                  )?.id;

                if (poll_id) {
                  const recipient_chain = normalize_chain(
                    attributes?.find(a =>
                      [
                        'destinationChain',
                      ].includes(a?.key)
                    )?.value
                  );
                  const voter = inner_message.sender;
                  const unconfirmed = logs?.findIndex(l => l?.log?.includes('not enough votes')) > -1;

                  let sender_chain,
                    vote,
                    confirmation,
                    late,
                    transaction_id,
                    deposit_address,
                    participants;

                  switch (type) {
                    case 'VoteConfirmDeposit':
                      sender_chain = normalize_chain(
                        inner_message.chain ||
                        attributes?.find(a =>
                          [
                            'sourceChain',
                            'chain',
                          ].includes(a?.key)
                        )?.value
                      );

                      vote = inner_message.confirmed || false;

                      confirmation = attributes?.findIndex(a =>
                        a?.key === 'action' &&
                        a.value === 'confirm'
                      ) > -1;
                      break;
                    case 'Vote':
                      sender_chain = normalize_chain(
                        inner_message.vote?.chain ||
                        _.head(inner_message.vote?.results)?.chain ||
                        inner_message.vote?.result?.chain ||
                        evm_chains_data.find(c => poll_id?.startsWith(`${c?.id}_`))?.id
                      );

                      const vote_events = inner_message.vote?.events ||
                        inner_message.vote?.results ||
                        inner_message.vote?.result?.events;

                      vote = (
                        Array.isArray(vote_events) ?
                          vote_events :
                          Object.keys({ ...vote_events })
                      ).length > 0;

                      const has_status_on_vote_events = Array.isArray(vote_events) &&
                        vote_events.findIndex(e => e?.status) > -1;

                      confirmation = !!event ||
                        (
                          vote_event &&
                          has_status_on_vote_events &&
                          vote_events.findIndex(e =>
                            [
                              'STATUS_COMPLETED',
                            ].includes(e?.status)
                          ) > -1
                        );

                      late = !vote_event &&
                        (
                          (!vote && Array.isArray(vote_events)) ||
                          (
                            has_status_on_vote_events && vote_events.findIndex(e =>
                              [
                                'STATUS_UNSPECIFIED',
                                'STATUS_COMPLETED',
                              ].includes(e?.status)
                            ) > -1
                          )
                        );
                      break;
                    default:
                      break;
                  }

                  transaction_id = _.head(inner_message.vote?.events)?.tx_id ||
                    attributes?.find(a => a?.key === 'txID')?.value ||
                    poll_id?.replace(`${sender_chain}_`, '').split('_')[0];
                  if (transaction_id === poll_id) {
                    transaction_id = null;
                  }

                  deposit_address = _.head(inner_message.vote?.events)?.transfer?.to ||
                    attributes?.find(a => a?.key === 'depositAddress')?.value ||
                    poll_id?.replace(`${sender_chain}_`, '').split('_')[1];

                  if (
                    !transaction_id ||
                    !deposit_address ||
                    !participants
                  ) {
                    const _response = await read(
                      'transfers',
                      {
                        bool: {
                          must: [
                            { match: { 'confirm_deposit.poll_id': poll_id } },
                          ],
                          must_not: [
                            { match: { 'confirm_deposit.transaction_id': poll_id } },
                          ],
                        },
                      },
                      {
                        size: 1,
                      },
                    );

                    const {
                      confirm_deposit,
                    } = { ..._.head(_response?.data) };

                    if (confirm_deposit) {
                      if (!transaction_id) {
                        transaction_id = confirm_deposit.transaction_id;
                      }
                      if (!deposit_address) {
                        deposit_address = confirm_deposit.deposit_address;
                      }
                      if (!participants) {
                        participants = confirm_deposit.participants;
                      }
                    }
                  }

                  if (!transaction_id) {
                    const _response = await read(
                      'evm_votes',
                      {
                        bool: {
                          must: [
                            { match: { poll_id } },
                            { exists: { field: 'transaction_id' } },
                          ],
                          must_not: [
                            { match: { transaction_id: poll_id } },
                          ],
                        },
                      },
                      {
                        size: 1,
                      },
                    );

                    transaction_id = _.head(_response?.data)?.transaction_id;
                  }

                  if (!sender_chain) {
                    if (poll_id) {
                      const _response = await get(
                        'evm_polls',
                        poll_id,
                      );

                      sender_chain = _response?.sender_chain;
                    }

                    if (!sender_chain && deposit_address) {
                      const _response = await read(
                        'deposit_addresses',
                        {
                          match: { deposit_address },
                        },
                        {
                          size: 1,
                        },
                      );

                      sender_chain = _.head(_response?.data)?.sender_chain;
                    }
                  }

                  const record = {
                    id: txhash,
                    type,
                    status_code: code,
                    status: code ?
                      'failed' :
                      'success',
                    height,
                    created_at: get_granularity(created_at),
                    sender_chain,
                    recipient_chain,
                    poll_id,
                    transaction_id,
                    deposit_address,
                    transfer_id: Number(
                      attributes?.find(a => a?.key === 'transferID')?.value
                    ),
                    voter,
                    vote,
                    confirmation,
                    late,
                    unconfirmed,
                  };

                  _records.push(record);
                }
              }
            }
          }

          return _records;
        })
        .filter(t => t?.poll_id && t.voter);

      if (records.length > 0) {
        await sleep(1 * 1000);

        for (const record of records) {
          const {
            id,
            height,
            created_at,
            sender_chain,
            poll_id,
            transaction_id,
            voter,
            vote,
            confirmation,
            late,
            unconfirmed,
            participants,
          } = { ...record };

          if (confirmation || unconfirmed) {
            write(
              'evm_polls',
              poll_id,
              {
                id: poll_id,
                height,
                created_at,
                sender_chain,
                transaction_id,
                confirmation,
                participants: participants || undefined,
              },
            );
          }

          write(
            'evm_votes',
            `${poll_id}_${voter}`.toLowerCase(),
            {
              txhash: id,
              height,
              created_at,
              sender_chain,
              poll_id,
              transaction_id,
              voter,
              vote,
              confirmation,
              late,
              unconfirmed,
            },
          );
        }
      }
    } catch (error) {}

    // RouteIBCTransfersRequest
    try {
      const txHashes = tx_responses
        .filter(t =>
          !t?.code &&
          [
            'RouteIBCTransfersRequest',
          ].findIndex(s =>
            t?.tx?.body?.messages?.findIndex(m => m?.['@type']?.includes(s)) > -1
          ) > -1
        )
        .map(t => t.txhash);

      if (txHashes.length > 0 && endpoints?.api) {
        const api = axios.create({ baseURL: endpoints.api });

        for (const txhash of txHashes) {
          api.post(
            '',
            {
              module: 'lcd',
              path: `/cosmos/tx/v1beta1/txs/${txhash}`,
            },
          ).catch(error => { return { data: { error } }; });
        }
      }
    } catch (error) {}
  }

  response = lcd_response;

  return response;
};