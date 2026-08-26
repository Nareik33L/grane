cube(`orders`, {
  sql_table: `orders`,
  joins: {
    customers: {
      relationship: `belongsTo`,
      sql: `${CUBE}.customer_id = ${customers}.id`,
    },
  },
  measures: {
    revenue: {
      sql: `net_amount`,
      type: `sum`,
      title: `Revenue`,
    },
    count: {
      type: `count`,
    },
  },
  dimensions: {
    id: {
      sql: `id`,
      type: `number`,
      primary_key: true,
    },
    status: {
      sql: `status`,
      type: `string`,
    },
  },
});

cube(`customers`, {
  sql_table: `customers`,
  dimensions: {
    id: {
      sql: `id`,
      type: `number`,
      primary_key: true,
    },
    country: {
      sql: `country`,
      type: `string`,
    },
  },
});
