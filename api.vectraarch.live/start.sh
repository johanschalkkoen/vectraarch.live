#!/bin/sh
# Services hosted in api.vectraarch.live
pm2 start VectraArchCOMS.js     --name VectraArchCOMS
pm2 start VectraArchIdentity.js --name VectraArchIdentity
