// Generated from apps/frontend/src/lib/research/__tests__/presentation.golden.json (golden source commit 198a29cd).
// Do not edit: regenerate from the JSON so the Swift port is checked against the same fixtures.
let researchPresentationGoldenJSON = #"""
{
  "sourceCommit": "198a29cd",
  "cases": [
    {
      "name": "compare provider order, holiday alignment, duplicate timestamps and empty diagonal",
      "input": {
        "kind": "compare",
        "series": [
          {
            "symbol": "A",
            "points": [
              {
                "time": 3,
                "close": 12
              },
              {
                "time": 1,
                "close": 10
              },
              {
                "time": 2,
                "close": 11
              },
              {
                "time": 2,
                "close": 13
              },
              {
                "time": 4,
                "close": 0
              },
              {
                "time": 5,
                "close": null
              }
            ]
          },
          {
            "symbol": "B",
            "points": [
              {
                "time": 1,
                "close": 8
              },
              {
                "time": 3,
                "close": 10
              },
              {
                "time": 4,
                "close": 9
              }
            ]
          },
          {
            "symbol": "EMPTY",
            "points": []
          },
          {
            "symbol": "FLAT",
            "points": [
              {
                "time": 1,
                "close": 4
              },
              {
                "time": 3,
                "close": 4
              },
              {
                "time": 4,
                "close": 4
              }
            ]
          }
        ]
      },
      "expected": {
        "rows": [
          {
            "time": 1,
            "A": 83.33333333333334,
            "B": 100,
            "EMPTY": null,
            "FLAT": 100
          },
          {
            "time": 2,
            "A": 108.33333333333333,
            "B": null,
            "EMPTY": null,
            "FLAT": null
          },
          {
            "time": 3,
            "A": 100,
            "B": 125,
            "EMPTY": null,
            "FLAT": 100
          },
          {
            "time": 4,
            "A": null,
            "B": 112.5,
            "EMPTY": null,
            "FLAT": 100
          }
        ],
        "stats": [
          {
            "symbol": "A",
            "totalReturn": 0.08333333333333333,
            "volatility": 2.391676696597447,
            "maxDrawdown": -0.16666666666666666,
            "firstTime": 3,
            "lastTime": 2
          },
          {
            "symbol": "B",
            "totalReturn": 0.125,
            "volatility": 2.6074201976439433,
            "maxDrawdown": -0.1,
            "firstTime": 1,
            "lastTime": 4
          },
          {
            "symbol": "EMPTY",
            "totalReturn": null,
            "volatility": null,
            "maxDrawdown": null
          },
          {
            "symbol": "FLAT",
            "totalReturn": 0,
            "volatility": 0,
            "maxDrawdown": 0,
            "firstTime": 1,
            "lastTime": 4
          }
        ],
        "correlation": {
          "symbols": [
            "A",
            "B",
            "EMPTY",
            "FLAT"
          ],
          "matrix": [
            [
              1,
              null,
              null,
              null
            ],
            [
              null,
              1,
              null,
              null
            ],
            [
              null,
              null,
              1,
              null
            ],
            [
              null,
              null,
              null,
              1
            ]
          ]
        }
      }
    },
    {
      "name": "chart candlestick gaps, duplicate timestamp, macro negative values and rebased indicators",
      "input": {
        "kind": "chart",
        "series": [
          {
            "id": "price",
            "field": "price",
            "type": "candlestick",
            "points": [
              {
                "time": 1,
                "close": 5,
                "high": 6,
                "low": 4
              },
              {
                "time": 3,
                "close": 10,
                "high": 12,
                "low": 9
              },
              {
                "time": 3,
                "close": 11,
                "high": 12,
                "low": 9
              },
              {
                "time": 4,
                "close": null
              },
              {
                "time": 5,
                "close": 15
              }
            ]
          },
          {
            "id": "macro",
            "field": "price",
            "type": "line",
            "points": [
              {
                "time": 1,
                "close": -2
              },
              {
                "time": 2,
                "close": 0
              },
              {
                "time": 3,
                "close": 4
              },
              {
                "time": 4,
                "close": 6
              }
            ]
          },
          {
            "id": "volume",
            "field": "volume",
            "type": "bar",
            "points": [
              {
                "time": 2,
                "close": 1,
                "volume": 8
              },
              {
                "time": 6,
                "close": 1
              }
            ]
          }
        ],
        "indicators": [
          {
            "id": "sma",
            "type": "sma",
            "period": 2,
            "seriesId": "price"
          },
          {
            "id": "bb",
            "type": "bollinger",
            "period": 2,
            "seriesId": "macro"
          },
          {
            "id": "ema",
            "type": "ema",
            "period": 2,
            "seriesId": "macro"
          }
        ],
        "rebase": true,
        "oscillator": "none",
        "oscillatorSeriesId": null
      },
      "expected": {
        "rows": [
          {
            "time": 1,
            "price": 100,
            "price_o": 100,
            "price_h": 120,
            "price_l": 80,
            "macro": -50,
            "macro_o": -50,
            "macro_h": null,
            "macro_l": null,
            "volume": null,
            "sma": null,
            "bb": null,
            "bb_u": null,
            "bb_l": null,
            "ema": null
          },
          {
            "time": 2,
            "price": null,
            "price_o": 100,
            "price_h": null,
            "price_l": null,
            "macro": 0,
            "macro_o": 0,
            "macro_h": null,
            "macro_l": null,
            "volume": 8,
            "sma": null,
            "bb": -25,
            "bb_u": 25,
            "bb_l": -75,
            "ema": -25
          },
          {
            "time": 3,
            "price": 220,
            "price_o": 100,
            "price_h": 240,
            "price_l": 180,
            "macro": 100,
            "macro_o": 100,
            "macro_h": null,
            "macro_l": null,
            "volume": null,
            "sma": 210,
            "bb": 50,
            "bb_u": 150,
            "bb_l": -50,
            "ema": 58.33333333333332
          },
          {
            "time": 4,
            "price": null,
            "price_o": 220,
            "price_h": null,
            "price_l": null,
            "macro": 150,
            "macro_o": 150,
            "macro_h": null,
            "macro_l": null,
            "volume": null,
            "sma": null,
            "bb": 125,
            "bb_u": 175,
            "bb_l": 75,
            "ema": 119.44444444444444
          },
          {
            "time": 5,
            "price": 300,
            "price_o": 220,
            "price_h": null,
            "price_l": null,
            "macro": null,
            "macro_o": null,
            "macro_h": null,
            "macro_l": null,
            "volume": null,
            "sma": null,
            "bb": null,
            "bb_u": null,
            "bb_l": null,
            "ema": null
          },
          {
            "time": 6,
            "price": null,
            "price_o": 300,
            "price_h": null,
            "price_l": null,
            "macro": null,
            "macro_o": null,
            "macro_h": null,
            "macro_l": null,
            "sma": null,
            "bb": null,
            "bb_u": null,
            "bb_l": null,
            "ema": null
          }
        ],
        "oscillatorRows": []
      }
    },
    {
      "name": "chart RSI Wilder raw-close and indicator warmups",
      "input": {
        "kind": "chart",
        "series": [
          {
            "id": "s",
            "field": "price",
            "type": "line",
            "points": [
              {
                "time": 0,
                "close": 110,
                "high": 112,
                "low": 108,
                "volume": 100
              },
              {
                "time": 86400000,
                "close": 101,
                "high": 103,
                "low": 99,
                "volume": 101
              },
              {
                "time": 172800000,
                "close": 102,
                "high": 104,
                "low": 100,
                "volume": 102
              },
              {
                "time": 259200000,
                "close": 113,
                "high": 115,
                "low": 111,
                "volume": 103
              },
              {
                "time": 345600000,
                "close": 104,
                "high": 106,
                "low": 102,
                "volume": 104
              },
              {
                "time": 432000000,
                "close": 105,
                "high": 107,
                "low": 103,
                "volume": 105
              },
              {
                "time": 518400000,
                "close": 116,
                "high": 118,
                "low": 114,
                "volume": 106
              },
              {
                "time": 604800000,
                "close": 107,
                "high": 109,
                "low": 105,
                "volume": 107
              },
              {
                "time": 691200000,
                "close": 108,
                "high": 110,
                "low": 106,
                "volume": 108
              },
              {
                "time": 777600000,
                "close": 119,
                "high": 121,
                "low": 117,
                "volume": 109
              },
              {
                "time": 864000000,
                "close": 110,
                "high": 112,
                "low": 108,
                "volume": 110
              },
              {
                "time": 950400000,
                "close": 111,
                "high": 113,
                "low": 109,
                "volume": 111
              },
              {
                "time": 1036800000,
                "close": 122,
                "high": 124,
                "low": 120,
                "volume": 112
              },
              {
                "time": 1123200000,
                "close": 113,
                "high": 115,
                "low": 111,
                "volume": 113
              },
              {
                "time": 1209600000,
                "close": 114,
                "high": 116,
                "low": 112,
                "volume": 114
              },
              {
                "time": 1296000000,
                "close": 125,
                "high": 127,
                "low": 123,
                "volume": 115
              },
              {
                "time": 1382400000,
                "close": 116,
                "high": 118,
                "low": 114,
                "volume": 116
              },
              {
                "time": 1468800000,
                "close": 117,
                "high": 119,
                "low": 115,
                "volume": 117
              },
              {
                "time": 1555200000,
                "close": 128,
                "high": 130,
                "low": 126,
                "volume": 118
              },
              {
                "time": 1641600000,
                "close": 119,
                "high": 121,
                "low": 117,
                "volume": 119
              },
              {
                "time": 1728000000,
                "close": 120,
                "high": 122,
                "low": 118,
                "volume": 120
              },
              {
                "time": 1814400000,
                "close": 131,
                "high": 133,
                "low": 129,
                "volume": 121
              },
              {
                "time": 1900800000,
                "close": 122,
                "high": 124,
                "low": 120,
                "volume": 122
              },
              {
                "time": 1987200000,
                "close": 123,
                "high": 125,
                "low": 121,
                "volume": 123
              },
              {
                "time": 2073600000,
                "close": 134,
                "high": 136,
                "low": 132,
                "volume": 124
              },
              {
                "time": 2160000000,
                "close": 125,
                "high": 127,
                "low": 123,
                "volume": 125
              },
              {
                "time": 2246400000,
                "close": 126,
                "high": 128,
                "low": 124,
                "volume": 126
              },
              {
                "time": 2332800000,
                "close": 137,
                "high": 139,
                "low": 135,
                "volume": 127
              },
              {
                "time": 2419200000,
                "close": 128,
                "high": 130,
                "low": 126,
                "volume": 128
              },
              {
                "time": 2505600000,
                "close": 129,
                "high": 131,
                "low": 127,
                "volume": 129
              },
              {
                "time": 2592000000,
                "close": 140,
                "high": 142,
                "low": 138,
                "volume": 130
              },
              {
                "time": 2678400000,
                "close": 131,
                "high": 133,
                "low": 129,
                "volume": 131
              },
              {
                "time": 2764800000,
                "close": 132,
                "high": 134,
                "low": 130,
                "volume": 132
              },
              {
                "time": 2851200000,
                "close": 143,
                "high": 145,
                "low": 141,
                "volume": 133
              },
              {
                "time": 2937600000,
                "close": 134,
                "high": 136,
                "low": 132,
                "volume": 134
              },
              {
                "time": 3024000000,
                "close": 135,
                "high": 137,
                "low": 133,
                "volume": 135
              },
              {
                "time": 3110400000,
                "close": 146,
                "high": 148,
                "low": 144,
                "volume": 136
              },
              {
                "time": 3196800000,
                "close": 137,
                "high": 139,
                "low": 135,
                "volume": 137
              },
              {
                "time": 3283200000,
                "close": 138,
                "high": 140,
                "low": 136,
                "volume": 138
              },
              {
                "time": 3369600000,
                "close": 149,
                "high": 151,
                "low": 147,
                "volume": 139
              }
            ]
          }
        ],
        "indicators": [
          {
            "id": "ema",
            "type": "ema",
            "period": 12,
            "seriesId": "s"
          },
          {
            "id": "wide",
            "type": "sma",
            "period": 500,
            "seriesId": "s"
          }
        ],
        "rebase": true,
        "oscillator": "rsi",
        "oscillatorSeriesId": null
      },
      "expected": {
        "rows": [
          {
            "time": 0,
            "s": 100,
            "s_o": 100,
            "s_h": 101.81818181818181,
            "s_l": 98.18181818181817,
            "ema": null,
            "wide": null
          },
          {
            "time": 86400000,
            "s": 91.81818181818181,
            "s_o": 91.81818181818181,
            "s_h": 93.63636363636364,
            "s_l": 90,
            "ema": null,
            "wide": null
          },
          {
            "time": 172800000,
            "s": 92.72727272727272,
            "s_o": 92.72727272727272,
            "s_h": 94.54545454545455,
            "s_l": 90.9090909090909,
            "ema": null,
            "wide": null
          },
          {
            "time": 259200000,
            "s": 102.72727272727272,
            "s_o": 102.72727272727272,
            "s_h": 104.54545454545455,
            "s_l": 100.9090909090909,
            "ema": null,
            "wide": null
          },
          {
            "time": 345600000,
            "s": 94.54545454545455,
            "s_o": 94.54545454545455,
            "s_h": 96.36363636363636,
            "s_l": 92.72727272727272,
            "ema": null,
            "wide": null
          },
          {
            "time": 432000000,
            "s": 95.45454545454545,
            "s_o": 95.45454545454545,
            "s_h": 97.27272727272727,
            "s_l": 93.63636363636364,
            "ema": null,
            "wide": null
          },
          {
            "time": 518400000,
            "s": 105.45454545454545,
            "s_o": 105.45454545454545,
            "s_h": 107.27272727272727,
            "s_l": 103.63636363636363,
            "ema": null,
            "wide": null
          },
          {
            "time": 604800000,
            "s": 97.27272727272727,
            "s_o": 97.27272727272727,
            "s_h": 99.0909090909091,
            "s_l": 95.45454545454545,
            "ema": null,
            "wide": null
          },
          {
            "time": 691200000,
            "s": 98.18181818181817,
            "s_o": 98.18181818181817,
            "s_h": 100,
            "s_l": 96.36363636363636,
            "ema": null,
            "wide": null
          },
          {
            "time": 777600000,
            "s": 108.18181818181817,
            "s_o": 108.18181818181817,
            "s_h": 110,
            "s_l": 106.36363636363636,
            "ema": null,
            "wide": null
          },
          {
            "time": 864000000,
            "s": 100,
            "s_o": 100,
            "s_h": 101.81818181818181,
            "s_l": 98.18181818181817,
            "ema": null,
            "wide": null
          },
          {
            "time": 950400000,
            "s": 100.9090909090909,
            "s_o": 100.9090909090909,
            "s_h": 102.72727272727272,
            "s_l": 99.0909090909091,
            "ema": 98.93939393939394,
            "wide": null
          },
          {
            "time": 1036800000,
            "s": 110.9090909090909,
            "s_o": 110.9090909090909,
            "s_h": 112.72727272727272,
            "s_l": 109.0909090909091,
            "ema": 100.78088578088578,
            "wide": null
          },
          {
            "time": 1123200000,
            "s": 102.72727272727272,
            "s_o": 102.72727272727272,
            "s_h": 104.54545454545455,
            "s_l": 100.9090909090909,
            "ema": 101.08032992648377,
            "wide": null
          },
          {
            "time": 1209600000,
            "s": 103.63636363636363,
            "s_o": 103.63636363636363,
            "s_h": 105.45454545454545,
            "s_l": 101.81818181818181,
            "ema": 101.47356588184991,
            "wide": null
          },
          {
            "time": 1296000000,
            "s": 113.63636363636363,
            "s_o": 113.63636363636363,
            "s_h": 115.45454545454545,
            "s_l": 111.81818181818181,
            "ema": 103.34476553639048,
            "wide": null
          },
          {
            "time": 1382400000,
            "s": 105.45454545454545,
            "s_o": 105.45454545454545,
            "s_h": 107.27272727272727,
            "s_l": 103.63636363636363,
            "ema": 103.66934706226048,
            "wide": null
          },
          {
            "time": 1468800000,
            "s": 106.36363636363636,
            "s_o": 106.36363636363636,
            "s_h": 108.18181818181817,
            "s_l": 104.54545454545455,
            "ema": 104.083853108626,
            "wide": null
          },
          {
            "time": 1555200000,
            "s": 116.36363636363636,
            "s_o": 116.36363636363636,
            "s_h": 118.18181818181817,
            "s_l": 114.54545454545455,
            "ema": 105.97305053247375,
            "wide": null
          },
          {
            "time": 1641600000,
            "s": 108.18181818181817,
            "s_o": 108.18181818181817,
            "s_h": 110,
            "s_l": 106.36363636363636,
            "ema": 106.31286094006519,
            "wide": null
          },
          {
            "time": 1728000000,
            "s": 109.0909090909091,
            "s_o": 109.0909090909091,
            "s_h": 110.9090909090909,
            "s_l": 107.27272727272727,
            "ema": 106.74025296327194,
            "wide": null
          },
          {
            "time": 1814400000,
            "s": 119.0909090909091,
            "s_o": 119.0909090909091,
            "s_h": 120.9090909090909,
            "s_l": 117.27272727272727,
            "ema": 108.64035390598535,
            "wide": null
          },
          {
            "time": 1900800000,
            "s": 110.9090909090909,
            "s_o": 110.9090909090909,
            "s_h": 112.72727272727272,
            "s_l": 109.0909090909091,
            "ema": 108.9893903680016,
            "wide": null
          },
          {
            "time": 1987200000,
            "s": 111.81818181818181,
            "s_o": 111.81818181818181,
            "s_h": 113.63636363636363,
            "s_l": 110,
            "ema": 109.4245890526447,
            "wide": null
          },
          {
            "time": 2073600000,
            "s": 121.81818181818181,
            "s_o": 121.81818181818181,
            "s_h": 123.63636363636363,
            "s_l": 120,
            "ema": 111.33129563195811,
            "wide": null
          },
          {
            "time": 2160000000,
            "s": 113.63636363636363,
            "s_o": 113.63636363636363,
            "s_h": 115.45454545454545,
            "s_l": 111.81818181818181,
            "ema": 111.68592147878972,
            "wide": null
          },
          {
            "time": 2246400000,
            "s": 114.54545454545455,
            "s_o": 114.54545454545455,
            "s_h": 116.36363636363636,
            "s_l": 112.72727272727272,
            "ema": 112.125849642892,
            "wide": null
          },
          {
            "time": 2332800000,
            "s": 124.54545454545455,
            "s_o": 124.54545454545455,
            "s_h": 126.36363636363636,
            "s_l": 122.72727272727272,
            "ema": 114.03655808944009,
            "wide": null
          },
          {
            "time": 2419200000,
            "s": 116.36363636363636,
            "s_o": 116.36363636363636,
            "s_h": 118.18181818181817,
            "s_l": 114.54545454545455,
            "ema": 114.39457013162414,
            "wide": null
          },
          {
            "time": 2505600000,
            "s": 117.27272727272727,
            "s_o": 117.27272727272727,
            "s_h": 119.0909090909091,
            "s_l": 115.45454545454545,
            "ema": 114.8373635379477,
            "wide": null
          },
          {
            "time": 2592000000,
            "s": 127.27272727272727,
            "s_o": 127.27272727272727,
            "s_h": 129.0909090909091,
            "s_l": 125.45454545454545,
            "ema": 116.75049642022148,
            "wide": null
          },
          {
            "time": 2678400000,
            "s": 119.0909090909091,
            "s_o": 119.0909090909091,
            "s_h": 120.9090909090909,
            "s_l": 117.27272727272727,
            "ema": 117.11055990801957,
            "wide": null
          },
          {
            "time": 2764800000,
            "s": 120,
            "s_o": 120,
            "s_h": 121.81818181818181,
            "s_l": 118.18181818181817,
            "ema": 117.55508915293964,
            "wide": null
          },
          {
            "time": 2851200000,
            "s": 130,
            "s_o": 130,
            "s_h": 131.8181818181818,
            "s_l": 128.1818181818182,
            "ema": 119.46969082171816,
            "wide": null
          },
          {
            "time": 2937600000,
            "s": 121.81818181818181,
            "s_o": 121.81818181818181,
            "s_h": 123.63636363636363,
            "s_l": 120,
            "ema": 119.83099712886641,
            "wide": null
          },
          {
            "time": 3024000000,
            "s": 122.72727272727272,
            "s_o": 122.72727272727272,
            "s_h": 124.54545454545455,
            "s_l": 120.9090909090909,
            "ema": 120.2765779901597,
            "wide": null
          },
          {
            "time": 3110400000,
            "s": 132.72727272727272,
            "s_o": 132.72727272727272,
            "s_h": 134.54545454545453,
            "s_l": 130.9090909090909,
            "ema": 122.19206948817708,
            "wide": null
          },
          {
            "time": 3196800000,
            "s": 124.54545454545455,
            "s_o": 124.54545454545455,
            "s_h": 126.36363636363636,
            "s_l": 122.72727272727272,
            "ema": 122.55412872775823,
            "wide": null
          },
          {
            "time": 3283200000,
            "s": 125.45454545454545,
            "s_o": 125.45454545454545,
            "s_h": 127.27272727272727,
            "s_l": 123.63636363636363,
            "ema": 123.0003466857255,
            "wide": null
          },
          {
            "time": 3369600000,
            "s": 135.45454545454544,
            "s_o": 135.45454545454544,
            "s_h": 137.27272727272728,
            "s_l": 133.63636363636363,
            "ema": 124.91637726554396,
            "wide": null
          }
        ],
        "oscillatorRows": [
          {
            "time": 0,
            "rsi": null
          },
          {
            "time": 86400000,
            "rsi": null
          },
          {
            "time": 172800000,
            "rsi": null
          },
          {
            "time": 259200000,
            "rsi": null
          },
          {
            "time": 345600000,
            "rsi": null
          },
          {
            "time": 432000000,
            "rsi": null
          },
          {
            "time": 518400000,
            "rsi": null
          },
          {
            "time": 604800000,
            "rsi": null
          },
          {
            "time": 691200000,
            "rsi": null
          },
          {
            "time": 777600000,
            "rsi": null
          },
          {
            "time": 864000000,
            "rsi": null
          },
          {
            "time": 950400000,
            "rsi": null
          },
          {
            "time": 1036800000,
            "rsi": null
          },
          {
            "time": 1123200000,
            "rsi": null
          },
          {
            "time": 1209600000,
            "rsi": 52.127659574468076
          },
          {
            "time": 1296000000,
            "rsi": 57.48546511627907
          },
          {
            "time": 1382400000,
            "rsi": 52.3254630571952
          },
          {
            "time": 1468800000,
            "rsi": 52.832081171094416
          },
          {
            "time": 1555200000,
            "rsi": 58.10589199023347
          },
          {
            "time": 1641600000,
            "rsi": 52.89483736004412
          },
          {
            "time": 1728000000,
            "rsi": 53.39496455473478
          },
          {
            "time": 1814400000,
            "rsi": 58.60176737804527
          },
          {
            "time": 1900800000,
            "rsi": 53.34998085238545
          },
          {
            "time": 1987200000,
            "rsi": 53.84492702060234
          },
          {
            "time": 2073600000,
            "rsi": 58.998234605341224
          },
          {
            "time": 2160000000,
            "rsi": 53.71392761232003
          },
          {
            "time": 2246400000,
            "rsi": 54.20473576351945
          },
          {
            "time": 2332800000,
            "rsi": 59.31531120241056
          },
          {
            "time": 2419200000,
            "rsi": 54.00502516765435
          },
          {
            "time": 2505600000,
            "rsi": 54.492526714565884
          },
          {
            "time": 2592000000,
            "rsi": 59.56895180404071
          },
          {
            "time": 2678400000,
            "rsi": 54.237903017832046
          },
          {
            "time": 2764800000,
            "rsi": 54.7227612857556
          },
          {
            "time": 2851200000,
            "rsi": 59.77188425718839
          },
          {
            "time": 2937600000,
            "rsi": 54.42423566167134
          },
          {
            "time": 3024000000,
            "rsi": 54.90698024350982
          },
          {
            "time": 3110400000,
            "rsi": 59.93426957396089
          },
          {
            "time": 3196800000,
            "rsi": 54.57334561272762
          },
          {
            "time": 3283200000,
            "rsi": 55.05439956918887
          },
          {
            "time": 3369600000,
            "rsi": 60.06422428752481
          }
        ]
      }
    },
    {
      "name": "chart MACD raw-close, zero-loss RSI-independent warmup",
      "input": {
        "kind": "chart",
        "series": [
          {
            "id": "s",
            "field": "price",
            "type": "line",
            "points": [
              {
                "time": 0,
                "close": 2,
                "high": 4,
                "low": 0,
                "volume": 100
              },
              {
                "time": 86400000,
                "close": 2.1,
                "high": 4.1,
                "low": 0.10000000000000009,
                "volume": 101
              },
              {
                "time": 172800000,
                "close": 2.4,
                "high": 4.4,
                "low": 0.3999999999999999,
                "volume": 102
              },
              {
                "time": 259200000,
                "close": 2.9,
                "high": 4.9,
                "low": 0.8999999999999999,
                "volume": 103
              },
              {
                "time": 345600000,
                "close": 3.6,
                "high": 5.6,
                "low": 1.6,
                "volume": 104
              },
              {
                "time": 432000000,
                "close": 4.5,
                "high": 6.5,
                "low": 2.5,
                "volume": 105
              },
              {
                "time": 518400000,
                "close": 5.6,
                "high": 7.6,
                "low": 3.5999999999999996,
                "volume": 106
              },
              {
                "time": 604800000,
                "close": 6.9,
                "high": 8.9,
                "low": 4.9,
                "volume": 107
              },
              {
                "time": 691200000,
                "close": 8.4,
                "high": 10.4,
                "low": 6.4,
                "volume": 108
              },
              {
                "time": 777600000,
                "close": 10.1,
                "high": 12.1,
                "low": 8.1,
                "volume": 109
              },
              {
                "time": 864000000,
                "close": 12,
                "high": 14,
                "low": 10,
                "volume": 110
              },
              {
                "time": 950400000,
                "close": 14.1,
                "high": 16.1,
                "low": 12.1,
                "volume": 111
              },
              {
                "time": 1036800000,
                "close": 16.4,
                "high": 18.4,
                "low": 14.399999999999999,
                "volume": 112
              },
              {
                "time": 1123200000,
                "close": 18.9,
                "high": 20.9,
                "low": 16.9,
                "volume": 113
              },
              {
                "time": 1209600000,
                "close": 21.6,
                "high": 23.6,
                "low": 19.6,
                "volume": 114
              },
              {
                "time": 1296000000,
                "close": 24.5,
                "high": 26.5,
                "low": 22.5,
                "volume": 115
              },
              {
                "time": 1382400000,
                "close": 27.6,
                "high": 29.6,
                "low": 25.6,
                "volume": 116
              },
              {
                "time": 1468800000,
                "close": 30.9,
                "high": 32.9,
                "low": 28.9,
                "volume": 117
              },
              {
                "time": 1555200000,
                "close": 34.4,
                "high": 36.4,
                "low": 32.4,
                "volume": 118
              },
              {
                "time": 1641600000,
                "close": 38.1,
                "high": 40.1,
                "low": 36.1,
                "volume": 119
              },
              {
                "time": 1728000000,
                "close": 42,
                "high": 44,
                "low": 40,
                "volume": 120
              },
              {
                "time": 1814400000,
                "close": 46.1,
                "high": 48.1,
                "low": 44.1,
                "volume": 121
              },
              {
                "time": 1900800000,
                "close": 50.4,
                "high": 52.4,
                "low": 48.4,
                "volume": 122
              },
              {
                "time": 1987200000,
                "close": 54.9,
                "high": 56.9,
                "low": 52.9,
                "volume": 123
              },
              {
                "time": 2073600000,
                "close": 59.6,
                "high": 61.6,
                "low": 57.6,
                "volume": 124
              },
              {
                "time": 2160000000,
                "close": 64.5,
                "high": 66.5,
                "low": 62.5,
                "volume": 125
              },
              {
                "time": 2246400000,
                "close": 69.6,
                "high": 71.6,
                "low": 67.6,
                "volume": 126
              },
              {
                "time": 2332800000,
                "close": 74.9,
                "high": 76.9,
                "low": 72.9,
                "volume": 127
              },
              {
                "time": 2419200000,
                "close": 80.4,
                "high": 82.4,
                "low": 78.4,
                "volume": 128
              },
              {
                "time": 2505600000,
                "close": 86.1,
                "high": 88.1,
                "low": 84.1,
                "volume": 129
              },
              {
                "time": 2592000000,
                "close": 92,
                "high": 94,
                "low": 90,
                "volume": 130
              },
              {
                "time": 2678400000,
                "close": 98.1,
                "high": 100.1,
                "low": 96.1,
                "volume": 131
              },
              {
                "time": 2764800000,
                "close": 104.4,
                "high": 106.4,
                "low": 102.4,
                "volume": 132
              },
              {
                "time": 2851200000,
                "close": 110.9,
                "high": 112.9,
                "low": 108.9,
                "volume": 133
              },
              {
                "time": 2937600000,
                "close": 117.6,
                "high": 119.6,
                "low": 115.6,
                "volume": 134
              },
              {
                "time": 3024000000,
                "close": 124.5,
                "high": 126.5,
                "low": 122.5,
                "volume": 135
              },
              {
                "time": 3110400000,
                "close": 131.6,
                "high": 133.6,
                "low": 129.6,
                "volume": 136
              },
              {
                "time": 3196800000,
                "close": 138.9,
                "high": 140.9,
                "low": 136.9,
                "volume": 137
              },
              {
                "time": 3283200000,
                "close": 146.4,
                "high": 148.4,
                "low": 144.4,
                "volume": 138
              },
              {
                "time": 3369600000,
                "close": 154.1,
                "high": 156.1,
                "low": 152.1,
                "volume": 139
              },
              {
                "time": 3456000000,
                "close": 162,
                "high": 164,
                "low": 160,
                "volume": 140
              },
              {
                "time": 3542400000,
                "close": 170.1,
                "high": 172.1,
                "low": 168.1,
                "volume": 141
              },
              {
                "time": 3628800000,
                "close": 178.4,
                "high": 180.4,
                "low": 176.4,
                "volume": 142
              },
              {
                "time": 3715200000,
                "close": 186.9,
                "high": 188.9,
                "low": 184.9,
                "volume": 143
              },
              {
                "time": 3801600000,
                "close": 195.6,
                "high": 197.6,
                "low": 193.6,
                "volume": 144
              }
            ]
          }
        ],
        "indicators": [
          {
            "id": "b",
            "type": "bollinger",
            "period": 20,
            "seriesId": "s"
          }
        ],
        "rebase": false,
        "oscillator": "macd",
        "oscillatorSeriesId": "s"
      },
      "expected": {
        "rows": [
          {
            "time": 0,
            "s": 2,
            "s_o": 2,
            "s_h": 4,
            "s_l": 0,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 86400000,
            "s": 2.1,
            "s_o": 2.1,
            "s_h": 4.1,
            "s_l": 0.10000000000000009,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 172800000,
            "s": 2.4,
            "s_o": 2.4,
            "s_h": 4.4,
            "s_l": 0.3999999999999999,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 259200000,
            "s": 2.9,
            "s_o": 2.9,
            "s_h": 4.9,
            "s_l": 0.8999999999999999,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 345600000,
            "s": 3.6,
            "s_o": 3.6,
            "s_h": 5.6,
            "s_l": 1.6,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 432000000,
            "s": 4.5,
            "s_o": 4.5,
            "s_h": 6.5,
            "s_l": 2.5,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 518400000,
            "s": 5.6,
            "s_o": 5.6,
            "s_h": 7.6,
            "s_l": 3.5999999999999996,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 604800000,
            "s": 6.9,
            "s_o": 6.9,
            "s_h": 8.9,
            "s_l": 4.9,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 691200000,
            "s": 8.4,
            "s_o": 8.4,
            "s_h": 10.4,
            "s_l": 6.4,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 777600000,
            "s": 10.1,
            "s_o": 10.1,
            "s_h": 12.1,
            "s_l": 8.1,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 864000000,
            "s": 12,
            "s_o": 12,
            "s_h": 14,
            "s_l": 10,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 950400000,
            "s": 14.1,
            "s_o": 14.1,
            "s_h": 16.1,
            "s_l": 12.1,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 1036800000,
            "s": 16.4,
            "s_o": 16.4,
            "s_h": 18.4,
            "s_l": 14.399999999999999,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 1123200000,
            "s": 18.9,
            "s_o": 18.9,
            "s_h": 20.9,
            "s_l": 16.9,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 1209600000,
            "s": 21.6,
            "s_o": 21.6,
            "s_h": 23.6,
            "s_l": 19.6,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 1296000000,
            "s": 24.5,
            "s_o": 24.5,
            "s_h": 26.5,
            "s_l": 22.5,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 1382400000,
            "s": 27.6,
            "s_o": 27.6,
            "s_h": 29.6,
            "s_l": 25.6,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 1468800000,
            "s": 30.9,
            "s_o": 30.9,
            "s_h": 32.9,
            "s_l": 28.9,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 1555200000,
            "s": 34.4,
            "s_o": 34.4,
            "s_h": 36.4,
            "s_l": 32.4,
            "b": null,
            "b_u": null,
            "b_l": null
          },
          {
            "time": 1641600000,
            "s": 38.1,
            "s_o": 38.1,
            "s_h": 40.1,
            "s_l": 36.1,
            "b": 14.35,
            "b_u": 37.04894270665486,
            "b_l": -8.348942706654862
          },
          {
            "time": 1728000000,
            "s": 42,
            "s_o": 42,
            "s_h": 44,
            "s_l": 40,
            "b": 16.35,
            "b_u": 41.28274954753286,
            "b_l": -8.58274954753286
          },
          {
            "time": 1814400000,
            "s": 46.1,
            "s_o": 46.1,
            "s_h": 48.1,
            "s_l": 44.1,
            "b": 18.55,
            "b_u": 45.72870489924051,
            "b_l": -8.628704899240507
          },
          {
            "time": 1900800000,
            "s": 50.4,
            "s_o": 50.4,
            "s_h": 52.4,
            "s_l": 48.4,
            "b": 20.95,
            "b_u": 50.384027926874026,
            "b_l": -8.484027926874028
          },
          {
            "time": 1987200000,
            "s": 54.9,
            "s_o": 54.9,
            "s_h": 56.9,
            "s_l": 52.9,
            "b": 23.55,
            "b_u": 55.24671907311544,
            "b_l": -8.146719073115438
          },
          {
            "time": 2073600000,
            "s": 59.6,
            "s_o": 59.6,
            "s_h": 61.6,
            "s_l": 57.6,
            "b": 26.35,
            "b_u": 60.31530582815353,
            "b_l": -7.615305828153524
          },
          {
            "time": 2160000000,
            "s": 64.5,
            "s_o": 64.5,
            "s_h": 66.5,
            "s_l": 62.5,
            "b": 29.35,
            "b_u": 65.58868099144891,
            "b_l": -6.888680991448901
          },
          {
            "time": 2246400000,
            "s": 69.6,
            "s_o": 69.6,
            "s_h": 71.6,
            "s_l": 67.6,
            "b": 32.55,
            "b_u": 71.06599667670564,
            "b_l": -5.965996676705643
          },
          {
            "time": 2332800000,
            "s": 74.9,
            "s_o": 74.9,
            "s_h": 76.9,
            "s_l": 72.9,
            "b": 35.95,
            "b_u": 76.7465929950039,
            "b_l": -4.846592995003888
          },
          {
            "time": 2419200000,
            "s": 80.4,
            "s_o": 80.4,
            "s_h": 82.4,
            "s_l": 78.4,
            "b": 39.55,
            "b_u": 82.62994893218885,
            "b_l": -3.5299489321888657
          },
          {
            "time": 2505600000,
            "s": 86.1,
            "s_o": 86.1,
            "s_h": 88.1,
            "s_l": 84.1,
            "b": 43.35,
            "b_u": 88.71564779654315,
            "b_l": -2.015647796543149
          },
          {
            "time": 2592000000,
            "s": 92,
            "s_o": 92,
            "s_h": 94,
            "s_l": 90,
            "b": 47.35,
            "b_u": 95.00335245289673,
            "b_l": -0.30335245289673907
          },
          {
            "time": 2678400000,
            "s": 98.1,
            "s_o": 98.1,
            "s_h": 100.1,
            "s_l": 96.1,
            "b": 51.55,
            "b_u": 101.49278726703187,
            "b_l": 1.6072127329681294
          },
          {
            "time": 2764800000,
            "s": 104.4,
            "s_o": 104.4,
            "s_h": 106.4,
            "s_l": 102.4,
            "b": 55.95,
            "b_u": 108.18372473795068,
            "b_l": 3.7162752620493293
          },
          {
            "time": 2851200000,
            "s": 110.9,
            "s_o": 110.9,
            "s_h": 112.9,
            "s_l": 108.9,
            "b": 60.55,
            "b_u": 115.07597546124232,
            "b_l": 6.024024538757672
          },
          {
            "time": 2937600000,
            "s": 117.6,
            "s_o": 117.6,
            "s_h": 119.6,
            "s_l": 115.6,
            "b": 65.35,
            "b_u": 122.1693804964468,
            "b_l": 8.530619503553183
          },
          {
            "time": 3024000000,
            "s": 124.5,
            "s_o": 124.5,
            "s_h": 126.5,
            "s_l": 122.5,
            "b": 70.35,
            "b_u": 129.46380549414832,
            "b_l": 11.236194505851678
          },
          {
            "time": 3110400000,
            "s": 131.6,
            "s_o": 131.6,
            "s_h": 133.6,
            "s_l": 129.6,
            "b": 75.55,
            "b_u": 136.95913612810392,
            "b_l": 14.140863871896059
          },
          {
            "time": 3196800000,
            "s": 138.9,
            "s_o": 138.9,
            "s_h": 140.9,
            "s_l": 136.9,
            "b": 80.95,
            "b_u": 144.65527450690405,
            "b_l": 17.24472549309595
          },
          {
            "time": 3283200000,
            "s": 146.4,
            "s_o": 146.4,
            "s_h": 148.4,
            "s_l": 144.4,
            "b": 86.55,
            "b_u": 152.55213632906134,
            "b_l": 20.547863670938654
          },
          {
            "time": 3369600000,
            "s": 154.1,
            "s_o": 154.1,
            "s_h": 156.1,
            "s_l": 152.1,
            "b": 92.35,
            "b_u": 160.64964860817366,
            "b_l": 24.050351391826325
          },
          {
            "time": 3456000000,
            "s": 162,
            "s_o": 162,
            "s_h": 164,
            "s_l": 160,
            "b": 98.35,
            "b_u": 168.94774783943183,
            "b_l": 27.752252160568176
          },
          {
            "time": 3542400000,
            "s": 170.1,
            "s_o": 170.1,
            "s_h": 172.1,
            "s_l": 168.1,
            "b": 104.55,
            "b_u": 177.4463785108698,
            "b_l": 31.653621489130202
          },
          {
            "time": 3628800000,
            "s": 178.4,
            "s_o": 178.4,
            "s_h": 180.4,
            "s_l": 176.4,
            "b": 110.95,
            "b_u": 186.14549188614967,
            "b_l": 35.754508113850335
          },
          {
            "time": 3715200000,
            "s": 186.9,
            "s_o": 186.9,
            "s_h": 188.9,
            "s_l": 184.9,
            "b": 117.55,
            "b_u": 195.04504500289033,
            "b_l": 40.05495499710965
          },
          {
            "time": 3801600000,
            "s": 195.6,
            "s_o": 195.6,
            "s_h": 197.6,
            "s_l": 193.6,
            "b": 124.35,
            "b_u": 204.14499984334856,
            "b_l": 44.55500015665142
          }
        ],
        "oscillatorRows": [
          {
            "time": 0,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 86400000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 172800000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 259200000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 345600000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 432000000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 518400000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 604800000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 691200000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 777600000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 864000000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 950400000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 1036800000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 1123200000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 1209600000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 1296000000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 1382400000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 1468800000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 1555200000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 1641600000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 1728000000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 1814400000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 1900800000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 1987200000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 2073600000,
            "macd": null,
            "signal": null,
            "hist": null
          },
          {
            "time": 2160000000,
            "macd": 20.12013362502148,
            "signal": null,
            "hist": null
          },
          {
            "time": 2246400000,
            "macd": 20.72216434937715,
            "signal": null,
            "hist": null
          },
          {
            "time": 2332800000,
            "macd": 21.3804828445347,
            "signal": null,
            "hist": null
          },
          {
            "time": 2419200000,
            "macd": 22.09135365590275,
            "signal": null,
            "hist": null
          },
          {
            "time": 2505600000,
            "macd": 22.85125125847427,
            "signal": null,
            "hist": null
          },
          {
            "time": 2592000000,
            "macd": 23.656854778910947,
            "signal": null,
            "hist": null
          },
          {
            "time": 2678400000,
            "macd": 24.50504152821135,
            "signal": null,
            "hist": null
          },
          {
            "time": 2764800000,
            "macd": 25.392879676202128,
            "signal": null,
            "hist": null
          },
          {
            "time": 2851200000,
            "macd": 26.31762033714987,
            "signal": 23.004198005976072,
            "hist": 3.313422331173797
          },
          {
            "time": 2937600000,
            "macd": 27.276689284192685,
            "signal": 23.858696261619393,
            "hist": 3.4179930225732917
          },
          {
            "time": 3024000000,
            "macd": 28.267678467383575,
            "signal": 24.74049270277223,
            "hist": 3.527185764611346
          },
          {
            "time": 3110400000,
            "macd": 29.288337474528774,
            "signal": 25.65006165712354,
            "hist": 3.6382758174052334
          },
          {
            "time": 3196800000,
            "macd": 30.336565044519688,
            "signal": 26.587362334602773,
            "hist": 3.749202709916915
          },
          {
            "time": 3283200000,
            "macd": 31.410400718506637,
            "signal": 27.55197001138355,
            "hist": 3.8584307071230874
          },
          {
            "time": 3369600000,
            "macd": 32.50801669421145,
            "signal": 28.54317934794913,
            "hist": 3.9648373462623177
          },
          {
            "time": 3456000000,
            "macd": 33.62770993222277,
            "signal": 29.560085464803862,
            "hist": 4.067624467418909
          },
          {
            "time": 3542400000,
            "macd": 34.767894549670714,
            "signal": 30.601647281777236,
            "hist": 4.166247267893478
          },
          {
            "time": 3628800000,
            "macd": 35.927094525737644,
            "signal": 31.66673673056932,
            "hist": 4.260357795168325
          },
          {
            "time": 3715200000,
            "macd": 37.1039367346136,
            "signal": 32.75417673137818,
            "hist": 4.349760003235417
          },
          {
            "time": 3801600000,
            "macd": 38.297144314392625,
            "signal": 33.862770247981075,
            "hist": 4.43437406641155
          }
        ]
      }
    }
  ]
}
"""#
