/**
 * Gatheren Cloud — Standalone Two-Phase Loading Animation Module
 * File: gatheren-loading-animation.js
 *
 * Drop-in, zero-dependency animation component for Gatheren Cloud web properties
 * (files.gatheren.cloud, gatheren.cloud, scans.gatheren.cloud, etc.).
 *
 * Phase 1 (Looping Loading State):
 *   - 10 blue-to-green gradient-outline clouds drift along horizontal wind currents
 *     on a background layer behind the central Gathering Cloud logo.
 *   - The central logo gently breathes in luminance and soft cyan-emerald glow.
 *
 * Phase 2 (Completion & Fly-to-Header Transition):
 *   - Step 2A (Cloud Convergence, ~320ms): All floating clouds curve inward into
 *     the cloud part of the central house emblem with a brief luminous merge pulse.
 *   - Step 2B (Fly to Top-Left Header, ~380ms): The unified logo scales down and
 *     flies smoothly into the top-left navbar logo slot (.top-navbar .brand-cluster)
 *     while the loading backdrop fades out, handing off seamlessly.
 *
 * Phase 3 (Task Action Cloud & Trophy Burst):
 *   - GatherenLoader.burstClouds({ includeTrophy: false }) spawns clouds flying
 *     outward to all sides when a task is created or a comment is added.
 *   - GatherenLoader.burstClouds({ includeTrophy: true }) mixes flying clouds with
 *     trophy emojis of roughly the same size when a task is marked as "done".
 *
 * Quick Integration on Any Website:
 *   1. Include js/gatheren-loading-animation.js in your HTML page.
 *   2. Start Phase 1 loading loop:
 *        GatherenLoader.start({ targetSelector: '.top-navbar .brand-cluster' });
 *   3. When your app finishes loading data, trigger Phase 2 convergence & fly-to-header:
 *        await GatherenLoader.complete();
 */
(function (root) {
  "use strict";

  var CLOUD_SPRITE_DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAO4AAACeCAYAAAA1zDbjAABJlklEQVR42u29d5Qlx33f+6lfVfe9d+LmhAWwyACRARIEmKMoekhZI9KyZdl6Gu+zLNuyZfv5OZ8nh+Pj42xaTqQErpLFYEpLShyRIgmCBAmCyBlYpAWwu9iEjZPu7e6q+r0/qu+dmV0ABEiQxC76e87Mnbmhb3dXfesX6/eDBg0aNGjQoEGDBg0aNGjQoEGDBg1+TDDNLWjwYtjbu2eyKLuEqqIoClQVjZFIQDBYa7HWIuIYGR5l49Cbtjd3rSFugx8hnj56x+T8wlGOzjzPkeOHOD53lLnu3ERRdKeqqoQYidFDVCJ6AnGFPG9v63SGpleOrmZ8fCVDQ8MMdUZYsWINZ3be0hC6IW6DVwuPPvftyb37d7H/+efYe3D3RNBiytNDTcC4iDFINBEl0MlbiFGMMZj6EcBoOlZVBQw2mmjwPuJ9oN1us3LF6m0rx9dMn7H+LNas3sg5o+9pSNwQt8ErxTNH75l8ZvdOnn32KZ47sGeiW85MZW1Ha0gk4sFUqA0YCxDxGogxIgpGFBHBmCRxlfSaaiQTl15TiDERWkSIEbyPEW9ZvWLdtrM2nTe9+YzzWLd6M2vttQ2JG+I2eCk8sO/rkw8//iDPPLtzwvtyymYgVsXYiMmgCj0wASyIjVgrqInEWkWOMRE5TZhYH1VRAqKRVqsFmsSviYnQIQREHJnNMSrgDWWh0WjOhtVnb7vg3Eunzz7j4sY2bojb4ETc9cxXJx958iF2H9w5EWw1BVEwEQgYUSCiJiAWTK33GqO1yOxPj0gIimqAmD6DiRhTS2GUGCPWJIlsDbVKnT4vtUrtJMO5HIkOXwA+iyvHN2/bvPG86fM2X8rG0YbADXFf53j4+Vsn77zvdh59/OEJsjDVGneiEpPUrAlrDGAiGI8IWBLZjNTyVHXwE6MfkBgSYY0BQzqmrY8lmiSxMSaRWAQRIETQgJC80I4ME3N8ZYllFjesOmvbeWdfNn31eR9tyNsQ9/WHnUfvnbzzvtt58PH7JwrtTmVtK7QMQSJIrAmntaMJhIgxIUlQrZ1PosmmNQbB1hLWoxprm1ZriZts3b6kxsSa/AyOkySuIbNaS2uIIaDR0M7aWJtT9aAlY8TK3XjmxgunLzjnMs5d84GGwA1xXx/4+v1fmLznobsmnt79xFR7ZVtsy4BV1EFcQiYxERFqAoORgIkBIxFrpCZskrjEpCK32jbZtCESUdCwRALHpA4bRcQsI206RiCzBjRircUYQ4wR018c1JLbDo4Ox48UcbizZtu1l71t+qzNF7HSXdMQuCHu6YtP3fwbk3fff9eEZn5rPpwTqZgv5+mMdlBA1QxCOWICYg3GBKxRjESIYYmk7UtSs2SihFp6RlQMorF2TyXi5plJNrBJqrU5IXSUWZNIHyNGEmG9L+vPZvgq0s46ZDKMLx3VvItrV5+17arLrp++YM1EQ96GuKcX7j9w++Rtd36LJ555YiIfzraqBEotyDKLZJaiKhGRpO0OVONE1kWVWQFNJK6dSlJPDVWDUZLEjElFTvaxwVqDdYnoIZYDlTo9LnF0AfiKPM9raevBJm+1MUqeOarKJ7VcM6y2kDhEd9YzMrzyxqsve8v0hZsvZ1iubgjcEPfUx737bpv8oz/dPnFk/siUbVtBAoFAe7hFCKFOUTQ4azAxYogD4oIucVKZ5JwSQYzDpCAuISgxKBrAYWvHU9/BFeu4rmIkkLcECIiNYALRRFRD+iFio8E5CybifQ9sxLnkbo5BsTZL+rxaQhVpuQ6C0OuWuDgULz/v7dsuOOuq6fUr3taQtyHuq4dv77h7cmFhgaPHj3Hs2DHmuwt4XxExODED1dM5x3BniBUrVrBuzRre9obrvq+JeMtjX5v85ndvnpjzx7dGG6koydsZZdVDYTGzyViMQm4UwQ+cRQPvcH08EYEAwSuqhizL6eRDdDrDtFyL4dYImViy3GFtUouL0KUsu1S+S7c3h2qFUqJUqATA1x7qvkPLI6IoBYonawkiQuEr1BuyLJE3xkj0AYvBZULsOuiOcv6Wq258w8XXTm8ef//2hrgNvj+iPnnv5NO7n+Xxp57k0NEjzBfzE8aYKURBagePBUOSMrXCiK1jo74o0Ri3jQ+NTK8aG2fD6nVccM55vOfyd33PSXnrzm9O/uGXtk+YDlttBl5KYvQ4JygB5xxlWaKAtRkhBGzwaEyJEuoDGpTcZfjCE72iXjEqjI+Os3nzWWzeuJkVYysZGRnh/PHrvuf92HnkZubmj7Hv4G727dvNzOxhMIFWK8PmUGpJMD18mCNrG4x4fKzIsgzv0yKS5zm9Xi8tdCIEX5LnOeoN+DZVVzj7jDfceM3lb58+c/iD2xviNnhZ+OZT907eftedPPTwwxw+emSiPTo05ToZYi2toZYgyRmjkmKhUhO4731dTBckpRFiyJCYGaFaKImV35ZHO332GWdxxRsu5d1XnZzX+8V7vjD5zdu/NdEZbW2NORR+jognzyxVVWCN4EOJy5PDJ2jy3lqNZEaIAaxxCJaF2QWcOM7csJnNm87mjA2beNPZ739V7tW++W9z4MBzPP3MTnbvfRpvCrJhxWYllc5hbIm4lB6JMXWsOGIkIAIxeKy15C5nYaFHJhnOdijmLSuHz7zx3W+ZnD5r9H3bG+I2eFF88d7vTN5x/1089ewzEzMzM1OjK0axmRMyAdE61KJo/ZgcPLX6WautGn1S/ZzDWosS8N6njCIjWCNU3ZJWlsdyvsCJ23bmpjOmLzjvQiavS9Llpke/NnnTLV+fMLnZqi6iLhBNheLR4NE6r7jVahE0UhRV+j4jZF6RqGRZi5njc0QfOf+c87nkoss4Z/PZnN258od2/54+9E0eeeIhnt3/GAu9gwyNgY8zdMt5Wp0cEUGcxfsKI8kuDtGDGoQMYwxV2aOdtSHkUHXYtObCG6+76n3TZ43/xPaGuA2W4U8funvym3fcxhNP75xQq1NZOxNxNjl9alVYjVJ7bQZZScmG1GVpfw4lhBRSybIM6wyhzkqyJm2R6y10WTG6glCl3GBrJM7Pz29bMTI6fdF5W3jssUcnELZKDmo83XIB6xRxgq3jss45QghUVSDPc6oy0HYZLW8p57vECOeccx6XX3o5bz7r/T/S+/nszHd48tl7ue+Bb+PNccZWtumWXYxL98/lBsUnzcEarM2IPkljQ4lzDoJg6eDnHWesv/jG6696//Sm0fdub4jbgNufemLyS7d8nUefeWrCjXSmeqGQVrs9SCqoqiJNNCdYJ3hfDtTg5Lk1UEvefgZSjCn5INaJ+8YoNnOLyQimT2KHcw4RN8hSMsFHfIU1RtqdHO9LstxQVT2sM0AghECWZYgI3nvaWYsYAgZLy2SE44HR9ghvetObecelH/ix3t8nDk3z8OO3s/PZRwimy9BohsnAxwIfyzory9QebqGqSrIs0soyur15TBBGWytZmIXzN19943VXv396df6O1xV5XUPT5fjUN742+V+3fWKitExlo8MSc4sG6KnSzvK068UnFbQKFUWvIMscqtSSYXk+b98rFWPEOIu1GWoqvPf4ohgk8meZxToLaih9BVQpRGMzECMub1EWXZx6gnpMENSQHE+ZkFtXh3VcSlIslDxrQaV057pccc5V/IUP/uJr4h5fsGaCsbGVjI6s5sFHbqfqFVCV4AzGWJTas0zAuaSNaFR6ZUGrleG9p4izZJ0WT+66b+vQ0AjH/B2scNe9bshrG6om3LnnmckNb7jwkm/cftvE8LrVW0NmTXBCz/vkJbZC5UusSwRTIPiKLHe4LK1/YqjzdOn/ApPCkzbL0HoXzaL9a9AY0aiIMfjK42ySMDEGrBWKXo8YA1EDkgndXq9WjQ1RFWcdYi1V5VEVctfGYnFqkUrIguP97/gJ/swNP/Oaut8j9kzOXX89qzblzM/Pc+TIEYyJZFmeEjPE0Ol0wAqxTpXUekG0onjfwxhleKjD/v0Hrmq3hz77if/6xR2Nqvw6wpcfvm/yC1+anji6MDtFlonmFum0KIOnCml7mxWIMZBbl0IuYpPDyRpCVSR7VhcziwaeZBZ32jiXpGKoqqTuZFL/X6Yc3jrlMJF6scpEVJ8SGoC2s/XApQXA1u/J8zwlK1UwlHVYODLL6tFxfvonP8yF665+Td//XfM38egTd/LgjjtRKWgNG6pYYLN+PFrxoaTVylLqpfFYiZhoaMswseyQm/U3vuuGyenNoz+5vVGVXwf43VtumvzYb358ojM+utUNtQnWUsaAFCXGWow1GGepfEnezvE+2ZOSObwPiHO0Oh3KssTUerGiBNWU2WsM1hiMj1jjBrtoUpJB2qGTSYbBYMXgy4oYAyKGEAMigmpEciESBmETlwkhRkKIOOfoFp6Oy4lemZtf4IKzzuOXPvw3TokxOGv4vYxetYJOZ5Tv3n0TWkGn4wgURK0I6mm387QQGjvInRaBSgvEwuz8ga0PPHoHR6u7WZmd/pU1Xteq8r/7g09Nfv4rfzKxcuP6rYVRYmaJGNSAGkOqtlST0Si9XgEGrLHE4MnEEX3ARCWzjswImXU4IzgEq4qoIJrSBk2IZCbDiYWgGFWcsckOVoghYoygKD56xAqZywgEFMVZS/A+kTkCanCuRdEtcWT4XmTh2ByXnHsRv3yKkLaPDpsYW5ORuZyDzx8AIlluMURarQzwyeFHbYKgyRIxATDkWYtjR2evamcjn/3Er39+RyNxT1fS/uFnJ7/67W9OdFat3LoQA5plRCP1zpZkP4YYB9vhEGi3cnLrICq+1yVv50hUXFRCURKqkrIs8VWZUvyIdf2HSFmmOGuWtWi1MvI8J2vl5C5JkiqUSO0VjgSszcFEenX5F0NEfTpejEk1rqoKDZDbNk4yFubnOHPj2fyND//1U3JMVnI177zkaobaQ9x259cIWjA0Osx87yjSAqP1TgmgX/UqmoiYiIqnDDNy/yO3Tzw3ewtnjJ7eXubXJXH/xe/91uTN371tYmTNyq0xs1QawICGgNR5u2IMIdZVHjTgjMVEqHpdhvM2HdeChRKqCu8Dq8dWsH7DWZy1eTMb1q1leHiYLHdcve4CAG5/7hF6Vcnhw4c5dOQwzx88xK49uzh65DAjY8NgQTVg2w7E1PHhVGVGrCH4IqngITA8PEpZllhycuPw0TNz5BhXXHwZv/pTf/2UH583nfOLVFXg3gdvoTszi2Q5RkPShLRv90qqRglEE/HaozM2Ru/YkamHdtw53Ujc0wwfm56e/Mbt357IRke2zvuKoAFxFqeGECI6iMPWtZJQJChWIxIVqyC9AqpAy1iuvORKrrz4Yt5+4RUv+b1vPuMN6Y8ty5//2iO38+iTj/HAQw/iJdJpjZA7S+FTrFhchmpFNBaxDmNSbFZ9SrjIXc7CzDxnrNp4WpC2j7dcuBWicte9X2dkVZsqHidKHV2rs9TSCNXpLqJYGxhb1ZGdu++feHjPH3Dp5o9sb7zKpwE+fvM3Jn/jt7dNnHHuWVsX1IMVpJXhnBAqj/ceaxQndsnuGgVVRl1ONd9Fq5LV4yt491vezp+//l2v6vl9+tvT3Hb3nRyeOcKK1SuwLctC0SNvO6L4FEZSiFFxanDGUc50WTO2in/+V/7JaTdeR/39PP7kXdzxwE20xkqC6wIBRFGT9vyKSdloTixicigzqoWcVcPn3fiet/3M9Jr8zdsb59QpjD9++JHJbf/nsxMjq1ZsjdYQU6UzsjynKn3fdEqxWCBGP9jJY0pPnF1gZafD+972Tv7Zz23lss1bXvVzvOysC/ng9e/ieOiyf89z9LpdVo2twFrBR080EDXFfEWFtmuRk/Het76Tc9aefdqNWUc2sHnNNew+8CDdah4Vn2SNJMdUqn3Tn8KBGDzRl+RZxtzMwlXWZJ/95P+Y3tEQ9xTGwurxSw4X3X8zND5qqqhY68jzNkWvixghsxlaZ0+oRghKhsFFMN2SS8/awl/+yM/ywSve9EM/16vPuYSxtSs5tP8QRw4dptVq0yt7RI20sxa+FxjJhlk4Osv1176JD13zgdN67Noj8MzuJ8F4jEnmTFpodfAY60qUmbPECFVZmaIIc//rE//B/vt/vW1HQ9xTEL/6G5+YfObY8xMyMnRttAbjMowRYog4zbFqiDEVGlVniQqdLKeYmacTYfI9P8GvfuTn2Di28kd2zmet2si7rnkL3aJkx44dWCeMjYxRzhYMmZzQ9axfuZZf/vDUaT9+K4e3oNksu3c/TZanEFDsh4OAKsZk86oQfHIutrKc7nz3qhWjqz77v/7LH512xJXTfdB//94HJ7/zwAMT0bmtKgYVm7yTtWNDFSK2LqZmCWWgleVU3R7DNuNnJ/4sP/+u9//Yzv+j753gIx/8aYbsEDMHj9EmQ4uAnyt479vf/brxT1x77l/gjA3nMX+8RKPDaOpR1A/fDcJ4KCFUGPFgC9m1d8fEofLmyYa4pxDu3H9o8lP/57MTeXtoqxiHNS4V6Mf2kwbxApVRcBYRyMWgCwVtFX7+Iz/LR657y4/9Ot537Vv5yId+mrH2CN2ZBY4dPML73vEe3nzu1byecPGFVzPUXg0hQ2OWvOtqCCHtQwYGNa7KUIIJ7D+we2rvvmdpiHsK4U9vvomFqpgaWTGGtRnGWASLif1sKAgGgiilL3BGMIUnzs3zSz//l5m84prXzLVcv+UK/t3f+jUu2nIBl55/CT/1tp/k9YaL1nyIszdfxMKcgrdoMP0GJ4vEJaCiVL5AjSeYnux8dsfEke53JxvingL47p59kzffeutENjws4jIQi2jdNqcu3KbGpMSHereOL3qUx2fZ+rM/zwfOu+g1eV1/+y/+En/vr/wtXq/YsvlShvPVqE+b7H0VIaT9uyFUpGw1DxLBBWw7cuDwrql9z+9qJO6pgM9/6U8IeTYleU63KqG2bWGx/r6xgql722j0HDvwPD/7oQ/zkauvocFrExeu/SAXnX8lvbkKExxVUaVNH5r2JiOGKnhsbkGUSnsEujy3/+mGuK91fO3xJycf2/XsRD4yImQ5xjo0VRQmqEHjYtFvK0KGEObnuf7qa/ir735vw47XOM49+2IyGcJEhzV5Kk6wxEnVr/MVoqcKPWwe5flDeyd2H71psiHuaxjTN32dI/PdKXWO2V6PYIRQJzNGDLGWvNZApkquyuY16/j5n/6ZhhWnAM4ceRdnbj4fY1xdl0pTjS5r0WjAWHxQiqpCRVEbme0dnpqbP9pI3NestH3sqckHHntsgk5LYpZKpypCWYUUAnJJZbbGgA+4GPEzs0y+7ye4duWqhhWnjNS9kFAIjixJ3AhVFZIDUhyKJW+3sZlL+5hNdVqpy6cdcR96cifB2imynG4IdCtPFQMqNkldNWn3jSrOQJjrcu6GTfzMFVc1bDiFsGrlRtat3UyvG/FFhEEvX4Nq7W02KedcRbG5yrH55ycOdL8z2RD3NYg7HrifUixRMnxQvKai2957QkjVK4wxOEk7gtrA5E/8ZMOEU1Fd3nQevkx7lDXWxb009R8alMY1BhGDWM/x2UNTR2cONRL3tYYvPf7M5FO7d01UxkjPB7xC5nKstWR5PugsEH0glhVzR46xeniM9150YcOEUxDr155N7kbJJK873dvUK6l2UvV/gnqC8VR+gUOH9zbEfa3h8Wd2UolMDY2NI3mOkZRwXvRKgvcURQGqhMpDjEgMvPXNb24YcIpi5fgm1qzcQPCp7G1/YU5bMlO3wKiBECpUK8QGDh3Z1xD3tYannt1FNjQMLsPH5GmMMRVTE2NpZzmpfnjEhMhIZ4hfeNc7GgacoljrrmLjhrOoylRUTyS1cgHSZnt8nQIZwARUvBw5dmji+eqOyYa4rxXb9sChyWef2zORdYakUk2DKBkATgRixIqk6v7BM3/8GBece04z+09xbFh/BtYuFqRPRen7zbe1/kn7q2P0lNXC1Nz8sUbivlawZ/8BDh2bmTLWUfqAEUfebqV+M7UKFXyqbtFutejOzvDGqxpP8qmOsdE1DLXGMcFC1CRd0UEfJ2MMViJRK6IWYCrmug1xXzN49KmnMVmbqKmrOoD3JVEiEaUKiomgPhCKgrM2beScM85oZv4pjtH2SjasOZvgBVWD9xVIXX86QPAlqoFW2+Kp8LrA4aN7GuK+VvDAjh1UUUEcPiohKFiHYKiq1Osny1rkeZvoAyvGxrlm3dpm5p/iWMFVtFujqFoUt6S1qV3cDWYMaiKjYy3UFnL42J6JfdXXJpsqjz9m3HtsfvKv/5P/b8IPj0kIiu/v/ik8JgYskqwelxLRg4+ceebZzaw/TTA+shKNglGLSJ23jGAklW7tJ2H4UGKcY748tHXPgYfZOfuHZDJKLh2stFjTetP2hrg/Qhw+Psexue7U+Op1dENErcOa1NtHoiXLHF1folYoehVOhPPPPa+Z8acLccdXY2hhtELEoKl2bWpXYiLGRECptEs+NEq3Osyd99281Wp7KrNtrORktr3tD775jxnpDDM+tpZVK9ezYnw969o3bG+I+0PCgUNHODIzxwrXwhhHiIAIuViMB+8jtl6JUaWdtTlz05nNjD9NMDK0kpYbpow9TOpvUFceljopIzUfd7kABTFWyJDDiZfuwmHEG8TbrTM9M3XgqCHudmjM6bRXbPuDb/1TVo1t4KwzzmV4aAUbht66vSHuq0XcozOYLAfJscbiCcQApVbYKnUAktxRlWlTQafTZqjdaWb8aYJWa5hOe5SidyxV6ERS6da6GmREUe2HhyLGpuSMSisCPbLhHGscMUax6hATCT7S7e3dOnNg39TufY/w1LN3sXbNpm33P/tbbFh/Duvb79zeEPcHwF1HepO/8dk/nFi1br3ECKn+nxKjEn1EY8DZVJdIYsQXJevO3My1q4abGc/pUqo0Y2homCMLdRzXxAGB+83F1QjdXhcRy1BriFBFrBhcJwMLVdVdUrvKYsiQ3JFnVowWFNVxnty1c+uTT981tXrl5m23PPKfOWfzGzhz7APbG+J+H9i1/yB33nv/1ND4Cqrg8QGiQJ5liBMkCmhAg8cJeB/YtH5DM9tPIxhjaWdDmGAgKsYmdVkhdT3wAY2CdR2MQhUMVelptVqA0O0ViFFMXQ0/xlDHgQNEg/ee3CrDK3JMrOT4wjNb737gwNSzux7fdsfjH+fszRezfuhHK4FPeeJ+7otf5MjcHGtXraUoSvL2EKX3BO9xLUvhPQ7FGpNaXxrDGWubMNDphDXZFbRbX8Nai3OOSIkS004wUmNyZ9sYAyFEfAWGnLJICRpG2viqTNKZxQwsrbPtXG4RDajxVFWBa7fJs7Ycm9+59Tv37pl69Ml7tj2053c5Y8P5rHQ/GmfWKR3H/V+33Tv5nXvunVixfr2UISLi8GWJBl+3tiwJMSJOyKzQsUK5MM/K0dFmtp9myGxGVQVCSGTMXZ5IHFOh9LLweB+IkUF5G0hbPoNPCrdGC+oQk2NdmyxrIXV1UB8iGMHmFk+Pnj+ObXVpjfSk0H1bb7/vS5/71p1/PPHM0S9ONhL3JfCFp/ZO/q///amJ1spVW6PNiBHEgsaYOpmFiJfU37aqKlpAd26W9atWsnn9umamn2Zot0eIHmKVyrOKWAxK8Iq4OimjjipIX2Rp6oagqhiRgaRNVUDTZ3yMEMHSoaxS3rvLIt4nCe2sSdsGq54889zRrUeOHuTuZ36La7f84vZG4p6Ar+w5NvnfbvydiR3P7tnaHl9FLwIuQ+siYVIPgtQhgaJbYEOge/w4b7vuOq7buLKZ6aebxHUtnG1jpQXBUZaR7oJHY45oGxOlLqIN2v9RTQXyRVLZTwwiaV+vIKAmpclGIUSDMQ5jc4IavEZwBskCgXkqc5yRlYqXI1tvu+vLE1+87d9M7l24bbKRuDV+575nJv/DJ7ZNPHnw8NYVG8+iF8GblFSRSmOnpl1ibJK+qrRdTjE/y9oVo7z9ujc1s/y0VJVbZNIihqpOfcyJWJy08GXA1yq0SD1HCKhGYlQCijMOrbshRlKuM1LvMrNC9JoqhapirMWSo0YJeHCBLM+odB4k0Boe3rrn+Qem/H0L254+Ps054xPbX5fEvfP5hcmnDxzhG7ffxY2f+YOJIwu9rRvPvZijvQWqGGmNjlMWJbmk6hamlrYaQKPS7nQ48uzTvPt97+Atm9c0s/w0hJgcjYIGAVO3JwkCtk2oKoQWMQaqGFN3ewVjZKChRVGstSnua2LaBohP6jWCSOpJpECeZ1jnqPwCVQjkLUsIJZiIy8EZR8tkcvDoo1tvu/t5Ht7/+1y64S9uP62Je/9xP3loZo5Hn3yaJ3c9y+7nDvAP/9P/nHj++LGp4wsFqzdsEB0e4dBcFy8WFUdvoUjtFUVQEwBLiGlldVhmDh/n3LPO5O03XN/M8NOVuOKSt9haQqwoq0C3WzI81MbKCO18mEwcWZbhRFACVVVQliXel3S783gBIxVYwYjBOEFMxBCpQol1YDMh0EPVYzMwYvCxQqzgq5KgAeMMviqITihiufXOe77Kwzu/wKXn/tntpx1x//TpQ5N33vcg/+jff2xi76EjU0dm58G1yIeGGRkbEx1bzeg4dNWCZGAMrVbOQtEja7ewqkQiRgRnIBYFbZdjBZ7ds4u/8TemmLj43GaGn66qMsN0Z4VWbDM0Ns6G9ZsYGhlm1Yo1DHXGGGmPY22LvG7uppr6C5VlgQ8ls7PHOXb8MHv3P8uhw/uYL2YQq7Q7OVkbRA3qK7DgsgxfV9Yw6CCMlLUcgsX7Loohb7VRo0Rvtt5x31fY8ewXufjsD70q5DU/zpv9rYPHJx9+cg/bfv8zPPHM3olseGxqaHRE8uEhcFnqNi4OtSmN0eY5hJhc+CGQ545Qp7NFLenkGZQVNlYMi6UjjtnDh7n+DRfx3/7mzzWz+zTHroMP4DLYtPKK7/sYc9zH/MIxDhx8jl27nubg83uZK4/hOgFcgW1VVLqAZCUqFXnLUvgCEEwMOJcTfYCoOJPU9VxGkWoFxVx241ve9P7p8zdfQ9tctf2UI+4t+45O3nrPg/zxTd+c2H3g6JS0hqlMLjbPkcxirE1OPrE4m2NyR6/skrVbGJ8cTpl1eF/i8rT6GZv6/+SALbqMiSGrKsYzxz/6m3+VG85Y0czsBq+MxNW9HDi4j70HnmHP4Z0cOLILl5e0RxUvCwTmkQwCFTFGogYysTgnZGJThckyQHBkOoxWbXKzOr7luj/z0fNW/dypQ9z7Zvzkl7/5XT77x1+eeHjnnqnx9ZtlaHwlkreIBLCCtf3mxP3i5RliDcZCqEokBvJWhhNLUZW41hCIISIQPS2BVlUwGnoc2fUU//If/F0mr7ygmYUNfiA8N/t1Hnnqfp548gFwC5h2D3UL2DyA9Xjfw2WpLGyMEdG0D9gZ0CBkOoSGNt1Zw8qRM2+84Y1/ZnrLyp/Z/pon7m/d89Tk1265fWL7l26aWrXhLGmPryO6nJmFefLhVkolyyy5rWsfx4hX0JSwgmogswabGhGkm+MsUSXFcKOBUDCW5+jMEYaqOf7fX/5FfuaypiBcg1cHx7ifffuf4eHH7uTpvY/QHvGQ9XAtT9AFXJ7CTEKanxo9WWYx0RB7gmib4B1VN2PdivNvfO87fmZ6Tf6+7a9J4n5z38zkN+95hN/87PREz7S3rt1wJvOFx0dLNBAkEvFE9RiTwjjWpMA4RrHW4IwQYyTLLUW3hwiDGrohKFmWkVlHphXdQwdZP5Lzt3/h5/hzVzRVLhq8+jiq93HfQ9/m8Z330uMwrRGPzUuCLuB9Sd5Kc7PX64KJEAy5yfFFREyGM0MU8xmXXnDDjW+84ienx8wrz2/+oRL3d+/aOfk7/+ePJm5/ZOfUqnPfIJqPMbfQRVxO3mpTlD0CFdaBk5iC3lExGuo2mIrYFDT3PpJJ2v0hRiFEyqrH2NAQvizICPi541x94bn84kd/mg9sabKjGvxw8fiRP+aeB27myMJuTL6AuB5Be6mGc+11VlVCCLSkDTF5n0MBuR1j/pjE97/j5z56+eatrw3i3jcTJ2974Cn+9X/+nxPBjWxdc/YF7JsrcSOjeB8JMWKdARRnA77skrmUfylLTimihH5CuIlQBXIRJAY6zuDwWF+hxRx+/hjvuuFa/vJHJnnz2pFmVjX4kWDnzJe4456vsu/wY+RDFbbtKf08SsTlFkjplb2FLqPDHRYWFhAsVh1aDbN2xUU33nDNxPSWFa8sxvuqx3HvPq6T/+a/f3LiS7fcNbXp3MskZiMcnYfW0DgLvQrE4GNAg0FMpAyB3OWYWCEaB8nTqXu81pviI53MEdQjoSQLHhcC1ewRunPHeecN1zL5wSkmLmlU4wY/Wpw79kHsmwzfuTMw29tH2T2KV0MkUvkkcdvtNlkrZ6HXSz18VbFOyFqW548+s/XuB25hXu9h2Fyz/cdC3K/tOjr5r//7tonvPvj01jXnXsnx6NDSEIDMBzKrlKFKqq4aKl+RZ5boI9YIWZZBKIkx4MsKNTDc7iCZQ7wnhAJ6c8RinqGO5YbrL+e9b7uBD13aJFY0+PHh7OGfZOidQ9x6xxd5atdxpJWnPGciWMUIiALOIkZwIoQQKOMCWXuY/Yeemtqx857pH4vE/cqzxyY/tu0zE9++74mtw2vPpqstTGuIXlmRZVlKlIgR5yxKIMRInmW0XIavCpwxlN15WlYZzlITiaooWHj+KOX8PKE3z/pVY1x50bm8+erLufLCs3nPOU0liwavDaw17+Dqy2fxvmL3gUfIcsHHHlaU6AOqPoWKiFTRJM3SepACZ1qy46l7J56bu4kzRt67/UdG3C8+fnTy7/3zj008deD41tWbz6NyHaLYVIHACr2yoN3Ome/1cM7i8ixlPrmMXq+kk2UIgcxZrJ/n0P7nyKPn0gvO49Lrr2TNypWcs3EN5521kTeuaTWzpMFrU/IOTcCVysy3jzFX7MdKRah6hOgRmwrXBU059EYs1oA1EWcjC93DUzueunf6RyZxv7JzYfLjn/qjicefO7517TkX0cOBbeFjAPUYY8kyS1n2aLXy2ltssEbQEOhYy0gm+LljdI/vZ9OKDj/x/rdxwzVXcuGWLVw7bpoZ0eDUIe/Ih7juqqPc8t0/QkWJocJmhkhRt/9MvhuR1F0haoXaknzIy85nH5p4+tifcs6K712Azv1g2+108tf+y40TN9+9Y+uG8y9jpoJ8qEPpq3SSGoiFJ+/kqVF4jFCfvEQlxzOUK88//TgjdPlzP/kOPvyet/Ges5r0xAanLrZsuILZS49xx71fZWh4JdF0qZTk25FYE1fqLCtP0ALiPCq69ZHHvsuM3s2YuXb7D424n/mTm/nW3Y9Mrd58PnNlpJI6QcKCjeAEOpmjWFgg7+SpcGqMmLJgtJ1Bb4bZgwf5Sx9+Lx9+1/W874ym1nGDUx8jXMkbLujx/KF97HjqdkbXdBAJGBPStkF02ft99BgpcK2cPft3TO3af/70D610zb/7kwcnf+N/b59orVgt87GiMBXG1RXjXdr3SBXwCz2GXA6+ourOIdUCw6bHnodv56wx+LVf+Ut87Off3ZC2wWmFcd7M1Ze+ndHOBrRs4RiGIJiYGtGl+s2AdWlboCnxcRbj5mXXcw9PHI0vXfbm+yLu79y+f/Jjn/jUROys2urGVmLyNj4GSp+qAKimzCYxJhE4BkLRZTw3yMIxyiN7+IWfeh//8u/8Er/81oubUW5wWuLMsQ/ypivfg6lG6rpXGaqCqhBjKkonNu2G81qCq2gNB/Yfempq177HXl2Je/vzOvmZP75p4njobB0743xmSwjGoWLI8xwnGTZCKHqp0oAYSl/RNoHiyH6YOcCv/KWP8slf+Qjv2thuRrfB6W3vbryUjavOp5ozZNLBhAyNjjwbQg0UVUlFQbSBIBVFmKNXHZNdex6dmNU7Jl814n7lW/fzjdvvmRrbsJn5UsG1UWuxkkFUyrJMxnNmieopygWGWkLsHifMHObf/rO/zz/+UFOwrcHrA2uGr+fSS96IaBuNOZYWqMMYC8ZiXcpZUKOEmJpyiw3sP/Ds1N79T786EvfT9+ye3P7lr04Mr1wtPgTEZmR5m4X5kjxvoXWpy6IqQSwhRjKp6B7fx5Ap+He/9g/4hTee1Yxmg9cVNm7YzKaN51D2FJEcEZdK51RVXS8rdRUUaxERstwyO3eMvfueeXWI+5Xb7ubpA89PDa9ah1pXFxsPtNtDeB9RrdVl5/Ax4Kxi/BwLh/fwT//2L/GL121pRrEBrz8v8zVcfNGVSGwRg0FU6PV6aIigaQtgalaWmtMZo7RaVg4fOzBxYP7WyR+IuL/zwP7J7TfdMtFevVG6GMpoqELA5S0UAWMxdQ6mMUoMJWX3GM7P8K/+4d9qSNvgdY0Na85h/botlEVEI1SVJ8uylO8QIHilqgJlqPBakXfg2My+qSPHnvvBJO4XvvZtzPDqqfb4WoLk+JDaNQSFEA2Vh5GRMbIsQ33BmhUjlLOH+bkPf4C/8+7Lm5Fr8LrGCq5ny+aL0cphTEYr72BthvceEan7HMVU21kUsYFuNcOx2f3fP3E/dd/eyc9/5VsTMrRGjs0XVB4kc0SEykeiEcS1mJmZI5YFI7lj7xOP8NYrLuYvfvjdzag1aABsXHcOK8bXEkql5TqEoIMmZcYYnHOpODupjpXLghw5tm9i5gW8yy+LuNM33Uo+un7KtMZR20aNxceYikvXyRbGWDLXYqTVhmKWvJzhl/78JFcPNQPWoAHAWGctm9ZvoTcXCF6IFVjjqKqKqqowFqpQUlUFGI9rwaFj+6ZmFw6/con7xR3HJm/57v0ToyvWS1FqKsoG5HnOYqvCJOLFKL47w/G9u/i//9yH+MglTfmYBg36GOUKNq3fgol5SsaIGa28TYyJQ957rLXY3FHFAmzFQnGM4zMHXzlxb7r1Do4t+KlIi4ijX+1maY9RUVBf0RFwocu1F5/Lz37gXc1INWhwoq07spaVKzagMcO5FiFoHQ7qe5cDMXp89FSxxMceR2aef2XE/cZzvcnf/swXJtpjayWoIPHktxsFQ8RpIBQzLBzey0+//+28eVOTFdWgwYkYGVrNmpWbqLog0VGWPhVTNxFMJIQwqM2c+vYGOXR438S83j35sol7z8NPcGSumIquhZqljX9TO1GtGwVbjYy0hDB3lCvPP5u/+4ErmxFq0OCF7FzexJpVZ4JmGHIMKekixkgg4rVKbT7FIM4iueH47JGphWL+5Uvcp/cegtYQJZJaD0pEjeLN0m1JEYkeujMMU/JT731LMzoNGnwPddnZYUIAazJUDUZIdcVrlbnfAtQ5x/zCDPMLx18ecb/2XDF51/0PT4yu2SjRSL2H0BNM+iuiqEn2rdVImD3KZVs28Zar39CMTIMGL4FOe4xWPpySMTRlS1lMXei/btWhQkRQDRRFl9nZl0nc3XsOcN+DO6Y6o6OYzCXxbRQ1MVWzWFJRRjRSzBzh2ssv4s3rmppQDRq8pJ07vIIVY6vQAAY7SHXs79Htm6R9/6+qMjc3+/KIe9+jO+lhUZtThkg0oITlH4kBq5FMKyjmuOqipkxqgwbfC6vzN5JnbXwVqapArKAsAlWlxKgpPIRJWq4okilF+TJt3Eee3Yt0xjEuQ0QgRDQajBo0KBpAg0e05Njzz/ET73wzP3PlxmZUGjR4GVg5vgpnLJk4UEeejeJ0CKNt0Kzfx4NAIGs7mZ0/PjFT3TP5ksS9+Xmd3LXv0ER7bJUUla/FtUHqJiGQDGeiYiWC77LlzPXNaDRo8DLhXL0nF8EYh4k5aA7qQKXu5pEKy2EinnLKa/nSEnf//qPs27t/qtNJ+ZSqZpBPCaS/Na0IRlMvzDdccGEzGg0avEzkeT5oR7Lcrl2M2CxtHOa9X6xT9WLEPXjwEPO9ghhIlS1UUCNEdEltWMjEoKFgKLdsOfvMZjQaNHiZaLVagxKtJ6JPVpaEXKuqSBUyXoq4hw8dxWABizEZiGCsI8a6L61GjEZyMfhel7WrxnnHJmlGo0GDlwmb5aiY7yFxF59b6nV+UeIePz4LCC5r4UMcuKy1PpgxBkNEjFJ259m0obFvGzR4JUgNAyRpsydIXY3mpOdijN+buHNz81ibAUKMoGKJajCm7gdkDKJgVAlVweYNa5uRaNDgFaAvSY0xNVF5AYnbf80sI+2LErcoS7K8RVH6pDJr7U22qTSNE0FQiJ4YKlaMjzUj0aDB90Hcwd8DOsrL2rh30qv37o+T+/fvnxgZGRFr7TJnVL9Jb1EUiAhWILfCmpWrmpFo0OAVIISQ7FazSGIfI1VQqqhEVRRBjSGqIc/bL03cKnhm5+emRFINHBU7SL0SEWJI+nlfdFuROqOqQYMGLxfee6qqIoQAYmsqmvSji/kSyQYGYyzO5i9O3BAC1trBbvwQAi7PBvp4jHFQThJjod7B0KBBg5ePbrebSAsn2a8DaqpJPqZocDbfludDL05ckSRRW0MtXCtH3CJZB5Uv6q1HKQ5laHWGm5Fo0OAVYHZ2dgmH9AQ6pl08qn3HlMRWa2h6ZbbYetO9UCqWSNrGF0KFiCWgg5I1i9lTFmOUoAZrG4nboMHLxaHqPuYWZhFnlpFXUYyRZV5lIsQAw0OjL23jpqqNblu326UoClTDIlnj4kbf/rY+YwzHZ+aa0WjQ4GWiKAoWFhaw1hJjrAUly2O89OO3SZUeGRl7aeJeucZsz7JsOsYYVQNioaqKxRo4dc5yKoauIJbdu3c3o9GgwSuwb+fm5gbEHUjXOiGj75zqx3BVYegEc/QFg0Vr16yiKrq0soxQVanxbtS0kwGwxuBj6mCAOPbuP9iMRoMGL5e4vRnme7OYLGmuVQh1xz6WeZONGowKBEsnH/3exD1n83ooe8SqxKG0bYZzGU4cJiq+CBhpgeswPDbGwSNHuP9YMyANGrwsG/fYXsqwQMTjUYII0sqweYsQlRAiRHDSIpcWa8bXbVuz4szvTdxVYyP0uvPkklIbfVlRFAVVVaEhDqrSdXs95hZKnnj6aY4dX2hGpEGD74Ejxb3s27cbbMRYweUZLssIGCrv8RqxkqXNPcFQFTGuXLFhemV+1fbvTdxVq3BisFYQC8ZBljmMiah4jESMJPt3eHSMbhHYe+hIMyoNGnwPzM7PcuD5A1ibUYUUlYGU5NQvWyPi0sYeMnxpWbN6Ey+rIPq6tavJrKChGni5xNYb501qXWCcEA2pgbU6nn7uQDMqDRp8D+w58Bxl8NgsZSbGkDYSoEu7GShgETpYGWHV2MaXR9xNG8YZyu223sIsEPG+IvoK78vUIkH9oFVCGSLZ8Bi33nk/dx1uBqZBg5fC408+issNRgQjFnHZIOXR2qzOo3BotATvGOus27Zy/GVK3CvHzPbLLjl/uliYjWhAMLjMYsUQSJt6vfdElIiwcs0Gbr//kVRAvUGDBi+Ih/fdzJ6DuyADr35AweDjIHvKOYcVhyGnLIhrVp05febYDdtfdu+gG667Gt+bxapijUJIHflAUGOJMXXRLn2gxDJbKA89tacZnQYNXkzaPvMIVeyh4lNHEI34EKji0i1+hhAUJy2cabNpw3m8osbWW85Yh/gFrJZURY+i2yP4SAyKlRwrDpu3sFkLyTJiPsIDj+3k2/tjM0INGpyAp+fuZOeux8iHhUCFihJZlLKDyheV4ouImIx2a3TbujWbXhlxz964jjdfc8W20JvDxJJ2ltNyLTAZITqyfIgYDFkrZ6EoWbX+DO7f8TR3PfREM0oNGpyAJ3Y+yEJ1HMkVmxvK0K3zLLROK7ZY47DG0nIdZo9248Z1m6fPXXXd9ldE3PdtGdp+/VWXTh/atztmdWG4qqoQycjyFiFA5VOHA5PlmLzN4bmCP/n6d5pRatBgCXbN3M2jTzyAbUV8LFgoFlADzqWKMi3XwolFxKIxw5o2ZTdy0fmX8bIrYCzF5eefSYuS3ATQCiepDuxCUaIIrVYHjRDVsFAGWiOruPXeB/n0Q0eb0WrQoMYjj9/DoaN7wVZglUhy7hY+IOIoyxKNQizBhJzufGTj2rO2rV6x/vsj7nmb1/HGyy/ZVs4dJVY9MmsGRZy9puZfMcako1uHGxrGtMaZ/vqtzWg1aAA8uv+r3Pvw7eQjjjIUqIkYcUSEsqhwzhGC4ktFo8PQRqs8vuGiq6bXta7a/n0R94bNI9vf+9brp2MxHx2Bsuqi6slajqB+sMHeGIvYDLWO0bUb+Mq37uCTdzQ7hhq8vrEv3MMtt3+N2e4RsBU+VqnJVwRn24AjlJHMddAomNjCxBZjQ2u3nbflEl5RsbgT8cYrL2XL5o3bgi9wVonqiTGVt5FMBuVuqqqiUiFIzlwJv/PpP2pGrsHrGvc/dBdPPfMow2MZZdlFNRA01mWOU73yolcRfSQGwVfC/EwVz9/yhulNw2/c/gMR98OXjG9/19vfOt1dmIl57rDWAJFodElt2NTpoFdU9AKs3bSFO+99nH/1qdua0WvwusQdz/wRt333FkZWdoimQEUHlWNQQ/AGrffddhcq1EMoI203uu3ii678nsd/WX1D3nfDVQxL2GbKOai6tJ3FGYiqGOuoQsA5h3OOiKMbHevOvZjf/fyX+eoTM80oNnhd4Zm5+/nuHd+GTFEJlNGnPGTrUFXK0tfd+gy5bWPUYmNOMRfjpRdcMX3m8NXbXxXi/vRFw9s/+u63TC/s2xVH8OR4pFaXe75aUgVSMJLRC5Y56XAwOP7jts9w68GmfGuD1w9uvuVL7D24m85wi0AAa/H1zh/UoGLARNQHyl5g2I5gipy1o+u3vfmq61/Wd7zsTl0//6H3cOWWTdvy0EN7C2Ri6HW7iPbTtAI+RoIRSmPRzigjG8/hOw/v5JOfnW5Gs8HrAp/71sd5+IkHaQ1nzBXzlFEx4gZZh6pmUGNKsGSSoVWGX+DGN1311um1nSu3v6rEfduW9vafeMsV0/OH9t2YEYllyVCe4YzgywrvI8Y6xFmydouiUhYKWHvmxXz2i1/n1z5zSzOqDU5rfPbm/8Ed99zKilUjBIl4FGNzfDCI5IPeWwRPKAt8WRE9HD+2EC+84NLpt176F7a/3O96Rb0x/7+/+K7tb7v2sumFo8/H4ZYj9Eoshtw6hoeHKcuSMniqGFAEr46ZwrBy88V87Df/D3/tv/xhM7oNTkt86uv/jTvu+w7D4zleKoIoiCFgUOMw4nCSYYzBlxVV4cltTne2Ymxk1bY3v/Htr+j7XnFT25963w2EmYPbtDtPZlJZG4Beb2Gw6T6TDIi4vMVCyOjKOCObL+VTf3obv/pb3+Tupj5Vg9MIn77517nnoe8yvm4EOoo3JWWsUCcYK1QhojEVgHOS1fWSDaI5nXz8xnfe8P7p81e/ffsr+U77Sk/yjz75sR2/8Hf/mb3jnof/3NiK1SbEiBEDIkQNWHFURUHmUngIyYhYbJaRd9rceut32H/geTaffwlnjdlm1Bucsnho/618evo3eGrP43TGW3gpMBl4KowFW5PWimBhsO82czl4RzEX45uueMu//smrp7a/0u/+vpjznz7+25c88dTu+ecOHr6mMzJKWXlUI2JSXEoUrCqgGNNKKoNWlL5gbHwVTz+7m7vvfYhs5UZMe4gNww2BG5xauOn+z/GVW/6E491DSCtJWZVAGXqoUZxzlKHCGKWVZ6kpfExlajLTwheGjWu2fPKdb/nAE//13/zGjh8JcX/7P/+rHf/iYzfaz3zq03NDo2PX1CWd0aAYDBpTD10waN1eIeAR5whRGRpZwbO7n+OWW2/Dtjq0127i7NGGvA1ODfzm9H/iu/d8m2zIkI04Cu1i24Z8KEttRCQJLUWxBnyoEJtjbQ5B0MoSe9mNE+/7s9OXrXvH9u/nHMwPcgH//is7Jv/Ff/z450bWb5GSFgsVDI2ME/o9jFSoFGyeIUQ0eDCBWHZpidLSktlDe9m0coi/9NEJ3vWmy3nbBmlmRoPXHB45fD/3P3Q3jz72ICVdOqMOlYrSd4kmEE0FNoV6jPbzFiLWCGqEGCxCC6dtiuMhvuHcKz76f73/V7Z/v+fzA4m5//Dff/2S+bnu/Le+cfM1Y+Or6AwNU/mAKmjUpDLkGVWo0JDivUYMXhWcI5gMsg7Rtfj6rbfz2DO76Q2tJgyPs7nTTJYGP37cuetWvvXAN/j6rV9lz/O7KSmQFqiLRDzBBILxGGsGPX+iRsQYrLFJ61QhqMOYNq1snCce3fXJC86+/InP/94Xdny/52V+0Au760Ax+b+/cNPEx7Z9buvqsy9F2+NE20GcoyLig2KcJfikMotNO/7FKt6XdPIWvirQqiSPgdlD+zh/4yo++I7ruPzcjVy4ZT1v3TzUzKAGPzLcvfc7PLt3Fzsef5T9+/fiCXRGM7AKomA8WIN1mqqgaglEjCQJKyKI1mVWo8FITrQdfJnF3jG/7bF7n5r+2m98ZfsPco4/cH/MN65vbb/3kOfpZ5/jy9+5f+uG869iruoSyXFZTsBDMOQ2owwB1YjLM2KsCBiCtfiYk+UjVKVn/bnrOXjsEJ/43NfYMJ6zZtRy9hlreOOVl7BuzUrWrFrN2tVraOegAa5c8eoM1gMzetJzV4yZV3VCPDDf5YrhRpV4reH+/fdw6MhBntn1NHv27WJuYZb5sktQT95ytFoZ3noQxQqpiTSKjwFjNBUvF/A+EjWSZRYkJ0ZFVIi0CLF94+Fj89Mz++f5QUn7qkjcPu47rpP/8eOfnfjdz3156sw3XCvzavAmw7aGqAKIyVNSBiUuF0pN8V8xKa6VkWMUYlmQE8itkklg/vgRymKOlosY9YwOjzA03GZsZJThdoeyKFBfkWUZGK0ti9SAW02sQ9WRGF44X7pfXa/fhfDF2h2qhvrI6XjGGDA6eE+/Ifjiz2JnQ0xEJJ2PUQET6+OngYW61aKJ/Uug/9ViUhuYfpqcqQsYCKlhlFFQiRB1yfPpOP3XIZIZg1l2TXHJNca0t1o0dYozcdm1GwMOg+jiZ6T+XP9/axY/J0u6Otb9WTFGT7iv9WfrRxm8rCdMzPr1pVPVnFiQMNZd7/SFJ7kxWAR08b4rgSqUFEWPqiooQpes5dLwWshzh5pIiD4ZlJIqV9h6nGMMqX+0hSyTQYGJvgVqyDA4EIvSvvHQ8e70b/+1/7n91eLbqypS7pvVyd/89Fe48TN/PLHm7Iu39iRHTU7phRANNmtRUWKsodSKdrudKrmrIRYBZy2iEH2gnTti9BgDYhSxESFQliXEgAYIVZEmaqjL6tREjfXARuLgEqMPSybHyei3OzyRsANngJPBJFo6+frEXPq/SHJS9CvTYyKS6bIJJ0q9WjOYTMZQk2txQbDUx9eIDIhy4ijGE855+XkajeSmLrO7ZOEYnP9g4VhKuLi4CBERtO4jZ9J51tdl6S9cgtH6M6InvS8tPEuunyXnoKSFNxX/PWGCxsHCOeD+ScTVZYvBMoLX1+uMLFksNN3julCbaiBvZfhYgaVu2J5a7BiTevpYa+tOHooIOCv1ArDY7cO5HDEOH8DQAsliUcZtcwvV9G/98qtH2leduH38/d+/efI/f/IPPjey5mxxQ+OUwaDkuLyVupMRiCgud4ikXOc8ywilJ3dZKrYeADGptAdad1AIZGLR6DHBJLUlRMSChjiQiGpSoDsOJC6Yus3DS0ncF5O2J0uM+jOySJRUc3rJxBVZnLhErFs6sRaJZvoTtZbolvT59LoOiGMHYQZeQLLU3/8CkigtEhEbKoz6RL2BWNfFzzuzZAExyxYPI9TEjTUh6/dIvbCQ7rfUxxNJmkI6DssWOJZI2MGipyBiTkjli8tPcaDxLH1y8b0nLgyD76uJmy+9/xrS+WocXFtVFeSdtHh4X6Xxq++JquJMlu67BpQCAYyExWuTJGWVDDUZkN9YVHH6+Owcn/7bn9z+anPsh0Lc+xd08tYH9/EP/sW/nbD58NaxtWfQ0yEqMjCpG4IaKIOn1WrRKwrEGFp5m6qqsDZDfSAasNbi69xnEUH6EypqUiHrQVQfACX0Y8r1hFHtS65sGVFfKYHFLlHj5AVIbHSJCnyyRLbWnCQprdHFiVz/bQ0nqdqGSNTqJGm0dKK6TJaRWpZIJ6ORjIA1J5BiQOCkZpqBlNWTVH1bX3f/dVmywJj63glx8Lm+tJJl6m08QeuJA5Xb6HJCip5wfdbUUvqF74GRk59P55aOG2OJdYZB83dNi41lccGJ0afFqF6E45Lvcpr20hoC1iqYJKmVACpEFZA2znZiiHbb8dnu9O/9yse380OC+2Ec9Mohsx3gcw/u4bN/+Hn+9Fv3TLXPuELyzkoCmmwgSa0WyqIky9r4oETbpqrAGIdxgiVC9FhV1ApocrUPhkbB1GtPGExaqVfGvk5pBlnZovKiS9WLrWB9q7mMoVYlFUFqlXhR7EbCooTqm3amLwWlPtnlxFZdlORJ4hgiWn++VqN1sBQts09tXeurP3GTo2RRSqtZouqqwQfwA1XW1DZjXJSSVjBLpeCymyBESck1KBiSWk3sq/fpUVHQmN7nY704sahKm3S2i/dJ6htsSDHEtCBgFK2f7y+Apa8WVfEl/gWpn1Mfli+Wg0FN55Q5l+5VvwN8f3FdspBn1gKaCkQYwZhIMGmiqcaB2u59qremJoK1iDiiZlGks22hYPrY8Tk+9//85g+NtD80ibvM7n1+bvLzX72VX//MVydmdWjrytVraA2NcmyuC1kHyYcogyHUbvSyrMhsspfQgOs7AxCiGuKg58qipFTVgfPmhaQRCHJCyPpEybrUxn0BCziV7Km/oi9NlkqlqiqW2ZpLSQQxqfVLVFFZ8lqyCROxkwq5aLca7U+0uNwZxnKJvtRmXlw4FKOSjq9+QFJjqImv9WRclHi2fx4s10AGzrMli5MxijVLF4C+1NblJoHR2sZk+eKwhHj9Bap/vba+f/3jJF2qr6qfTNxYd5Yc+BkGtnq92Nr+nIiLpK0XR9E0PkK/h48S0xqFN4rRvnMuaUaxnnPpPRLVuG3WtqaPHZ/jM7+6bTs/Argf9hdctXZkO8AXdszzuS/dzPYvf3XKrd/McGtMKmcJJql5ZbfAtVrkNhKjp9Pu0OtVVMHU0ijWqspy722fuHyP3BIT9UUcGvWNMC+esRUNhOAHky6qGUzcdIhQLwym1gBqqTP4P3khjalX7iWkFqNoiARiqopwEnHrCSf9zyxfcpeZ4rUXua/C9o9lYkRjSFKzfi4OVOA+UdOZKhGDpselEiku+Q5RpDZBotTEN7UU1sUFzhhJHx/4G04mLrr4uPh6IsfyAazTCGtp3Ne0+mNvrV0mca2YJYtM8iJrIhpmqS9AQY1J54qBmBaJWHvpjfR9EULQmGpFiWBtFlGzrSqr6aLyfOpXP/EjIeyPTOIuC2wf08nv3vMEv/f5P+G+x56ZcCNrptzYKjH5ELY1xPxCjxgjQ0NDFEVZl8Mx6caqDoIxQXXwv8WCTRsbouEFH6krUQ7U1yVhnf6jtdkLPt9/DH1VeKntafSk8MaJHubBIiFaP7dc4i5KqLjE7tVFSVqHfZYqFIuSdfH4A+9zLaX7TrLknEkF7fsk7duei9I6DvwHJ9q6Sx1GJx67vwDZpQ6t2g49OeRTO4KUZYQyfVu3XqDMQEcyy5xRxoTahmZZ+K5/rurDC9jgS++RT05LscuchNJfE7xfZrf3bVwfk8BouRaqJho1KLItRqYXeiW//6sf/5ES9sdC3KX4vbt3T37569/ha9++e2LW26nW2BqxwytwrSEWeiU+JPXGWkuMkSoo4myd+5nCOxHFGouxMohjLo1fqgET0/tVdZmXcRCvxL7g8yc9LgmXLHPs1H8PVO0XIG6SoH5ZiGWZqidLnEEnTM5+2EREFu3DQRhm8TtkiWppzRI13FgMHpGlhFxUMY2kRVD7XRmX2L1LPd/9OLZd4ozrX4csWWjS4nDC5zXW18/Ahh2YEJhl8esBgQffXRPMhmXnP9BYlmgYA1VaTozNa92kPSaqmjhQVfqqstRJUeiSeL8YVIgGQdVsc7Y9LSrMdbv87q/8+nZ+jDD8mDH92NHJz//pN3h05/6JXc8fmzp4fAGVjJWr10kEiqKow0ikZsAmEblfjN25PHmevX/BcE9fYorIIDyUSCcvKWFPfqT2VPMCHlmW2Nh6Qmy3b6P5AZFY6r2tpVEK5+jAVh1MvL7UsnJSbHZpuGaggi6Z9EsJLCYuWzjsCd+RnEzLvc2Lcd8ksU+MW5tao1n06MZlC88iURe1CjnB/jdLkjhkiePRLCWvRqxbdMotWwD7GscLxInjwFZetOG1Nn2WjaVGWjaHGJKqrCFGBCO6TUSmMQZfGbb9tf+0ndcIzGvlRO55vpq8f8dO7nnkKXbtP8Qtt909UalM9cpA3hmiNbRCsIK1qQxs36bRaJY4l16YuDoI5yzNfLIv+f/SRzUv5vRanoF0YjbVoroYU13dWsInG3GJE2mJxDBLiLDcfjUn/W1OIp85wQG21AnjB46wlEm0nDxLEyiWZkCBwUgE/DLCLi4Ii/6HxdDMyZKzf/8XbVxdZsMvho5OzpQSIi5blKiDa14SArJGaq2gVq1jch4l30YcePUVIQjJW5xWM4zGuictCGabMTqtavCx4n//zV9/zZD1NUncE3HTs8XkgcNHefSJnczOl+zY+ezE3EJ3aub4LN1ulxDCkskstcSTZSGMZa4oE19SFY6BF38dUklNTs5YesE0vhM8y4NwUW1z9jOLlnpd+/a8aHwBic0LesRfKMPpRBXRGMGo1gnxSS1UScRdttDEsCweapd6lU1EZIlNLydnWMXga7/UyTHulHlmlqRzLsa05QVSIJded18DydxyjUPMCXH2vkOsTq5YbBTdv7eaivhjiNbghW3BML2YsJPuQQiBL/yD/7Gd1zgMpwjuOFBNlj5Q9Ep6vR5FUeC9r51OklIhX4K4VayIhBdVhVOixgmSVsPgmCeHm14oc+fFUhD74cplCcQDZ6lq6t62PPNpuWRPzrMXk/w1eV8wCp0k5yDXuR/tPiH7aGkK4onJSVrHQ6PhRc/BGl3iDDw5tNZX5096XlkikRedieaEN1vhhVNWzQuH8cwSr7Sa1IfWo2iWEa3h4Sce45//9C9tp0GDBg0aNGjQoEGDBqcT/n/vE4/THQrwRQAAAABJRU5ErkJggg==";
  var CLOUD_BASE_W = 238;
  var CLOUD_BASE_H = 158;

  // Inner cloud relative position inside the horizontal Gathering Cloud logo (1024x411)
  var INNER_CLOUD_X_RATIO = 0.212;
  var INNER_CLOUD_Y_RATIO = 0.545;
  var INNER_CLOUD_W_RATIO = 0.232;

  // 10 Floating clouds configuration (normalized around 1920x1080 reference center 960, 540)
  var CLOUDS_TEMPLATE = [
    { ox: -510, oy: -210, ax: 35, ay: 14, freq: 1.3, phase: 0.2, scale: 0.72, opacity: 0.90 },
    { ox: -230, oy: -260, ax: 28, ay: 12, freq: 1.1, phase: 1.4, scale: 0.76, opacity: 0.94 },
    { ox:  150, oy: -255, ax: 32, ay: 15, freq: 1.4, phase: 2.5, scale: 0.70, opacity: 0.88 },
    { ox:  330, oy: -315, ax: 30, ay: 11, freq: 1.2, phase: 3.8, scale: 0.74, opacity: 0.95 },
    { ox:  500, oy: -190, ax: 36, ay: 13, freq: 1.0, phase: 4.9, scale: 0.72, opacity: 0.90 },
    { ox: -565, oy:   20, ax: 40, ay: 16, freq: 1.5, phase: 0.9, scale: 0.75, opacity: 0.92 },
    { ox: -475, oy:  210, ax: 30, ay: 14, freq: 1.2, phase: 2.1, scale: 0.74, opacity: 0.92 },
    { ox:  -95, oy:  270, ax: 34, ay: 12, freq: 1.3, phase: 3.3, scale: 0.71, opacity: 0.89 },
    { ox:  105, oy:  215, ax: 32, ay: 15, freq: 1.1, phase: 4.4, scale: 0.75, opacity: 0.94 },
    { ox:  480, oy:  200, ax: 28, ay: 13, freq: 1.4, phase: 5.5, scale: 0.73, opacity: 0.91 }
  ];

  function easeInOutCubic(t) {
    var clamped = Math.max(0, Math.min(1, t));
    return clamped < 0.5
      ? 4 * clamped * clamped * clamped
      : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
  }

  function injectScopedStyles() {
    if (document.querySelector("style[data-gatheren-loader-styles]")) return;
    var style = document.createElement("style");
    style.setAttribute("data-gatheren-loader-styles", "1");
    style.textContent = [
      ".gatheren-loading-overlay {",
      "  position: fixed;",
      "  inset: 0;",
      "  z-index: 95000;",
      "  overflow: hidden;",
      "  pointer-events: all;",
      "  user-select: none;",
      "  -webkit-user-select: none;",
      "  display: block;",
      "}",
      ".gatheren-loading-overlay.hidden {",
      "  display: none !important;",
      "  visibility: hidden !important;",
      "  pointer-events: none !important;",
      "}",
      ".gatheren-loading-backdrop {",
      "  position: absolute;",
      "  inset: 0;",
      "  background: #0b101b;",
      "  backdrop-filter: blur(10px);",
      "  -webkit-backdrop-filter: blur(10px);",
      "  transition: background-color 0.2s ease;",
      "  will-change: opacity;",
      "}",
      ".gatheren-loading-overlay[data-loader-theme='light'] .gatheren-loading-backdrop {",
      "  background: #f8fafc;",
      "}",
      ".gatheren-loading-clouds-layer {",
      "  position: absolute;",
      "  inset: 0;",
      "  z-index: 1;",
      "  pointer-events: none;",
      "}",
      ".gatheren-loading-cloud {",
      "  position: absolute;",
      "  top: 0;",
      "  left: 0;",
      "  transform-origin: center center;",
      "  will-change: transform, opacity;",
      "  pointer-events: none;",
      "}",
      ".gatheren-loading-aura {",
      "  position: absolute;",
      "  top: 0;",
      "  left: 0;",
      "  z-index: 1;",
      "  border-radius: 50%;",
      "  pointer-events: none;",
      "  filter: blur(36px);",
      "  -webkit-filter: blur(36px);",
      "  will-change: transform, opacity, width, height;",
      "}",
      ".gatheren-loading-merge-pulse {",
      "  position: absolute;",
      "  top: 0;",
      "  left: 0;",
      "  z-index: 2;",
      "  border-radius: 50%;",
      "  pointer-events: none;",
      "  background: radial-gradient(circle, rgba(139, 195, 74, 0.65) 0%, rgba(56, 189, 248, 0.35) 55%, rgba(56, 189, 248, 0) 100%);",
      "  filter: blur(18px);",
      "  -webkit-filter: blur(18px);",
      "  opacity: 0;",
      "  will-change: transform, opacity;",
      "}",
      ".gatheren-loading-logo-wrap {",
      "  position: absolute;",
      "  top: 0;",
      "  left: 0;",
      "  z-index: 3;",
      "  transform-origin: top left;",
      "  will-change: transform, width, height, filter, opacity;",
      "  pointer-events: none;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "}",
      ".gatheren-loading-logo-img {",
      "  width: 100%;",
      "  height: 100%;",
      "  object-fit: contain;",
      "  display: block;",
      "}",
      ".gatheren-burst-layer {",
      "  position: fixed;",
      "  inset: 0;",
      "  z-index: 96000;",
      "  pointer-events: none;",
      "  overflow: hidden;",
      "  user-select: none;",
      "  -webkit-user-select: none;",
      "}",
      ".gatheren-burst-item {",
      "  position: absolute;",
      "  top: 0;",
      "  left: 0;",
      "  pointer-events: none;",
      "  will-change: transform, opacity;",
      "  transform-origin: center center;",
      "}",
      ".gatheren-burst-trophy {",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  line-height: 1;",
      "  filter: drop-shadow(0 6px 16px rgba(245, 158, 11, 0.48));",
      "}",
      ".gatheren-task-complete-popup {",
      "  position: fixed;",
      "  top: 50%;",
      "  left: 50%;",
      "  z-index: 96500;",
      "  pointer-events: none;",
      "  user-select: none;",
      "  -webkit-user-select: none;",
      "  transform: translate3d(-50%, -50%, 0) scale(0.4);",
      "  opacity: 0;",
      "  will-change: transform, opacity;",
      "}",
      ".gatheren-complete-aura {",
      "  position: absolute;",
      "  inset: -18%;",
      "  border-radius: 50%;",
      "  background: radial-gradient(circle, rgba(250, 204, 21, 0.34) 0%, rgba(56, 189, 248, 0.24) 48%, rgba(16, 185, 129, 0) 74%);",
      "  filter: blur(24px);",
      "  -webkit-filter: blur(24px);",
      "  z-index: 1;",
      "}",
      ".gatheren-complete-big-trophy {",
      "  position: absolute;",
      "  z-index: 2;",
      "  line-height: 1;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  filter: drop-shadow(0 14px 28px rgba(245, 158, 11, 0.55));",
      "  transform-origin: center bottom;",
      "}",
      ".gatheren-complete-cloud-wrap {",
      "  position: absolute;",
      "  z-index: 3;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  filter: drop-shadow(0 12px 26px rgba(15, 23, 42, 0.42));",
      "}",
      ".gatheren-complete-cloud-img {",
      "  width: 100%;",
      "  height: 100%;",
      "  object-fit: contain;",
      "  display: block;",
      "}",
      ".gatheren-complete-cloud-text {",
      "  position: absolute;",
      "  top: 57%;",
      "  left: 51%;",
      "  transform: translate(-50%, -50%);",
      "  width: 78%;",
      "  text-align: center;",
      "  font-weight: 800;",
      "  letter-spacing: 0.02em;",
      "  line-height: 1.15;",
      "  color: #0f172a;",
      "  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.9), 0 2px 8px rgba(14, 165, 233, 0.22);",
      "  white-space: nowrap;",
      "}",
      "#studioDetailStreamBar, #previewDetailStreamBar, #volProgressBar, #catProgressBar, #contoursProgressBar, #studioVolProgressHudFill {",
      "  transition: width 0.28s cubic-bezier(0.22, 1, 0.36, 1) !important;",
      "}",
      "@keyframes gsResultReadyPulse {",
      "  0% { transform: translate3d(0, 3px, 0) scale(0.992); box-shadow: 0 0 0 0 rgba(56, 189, 248, 0), 0 0 0 0 rgba(16, 185, 129, 0); }",
      "  38% { transform: translate3d(0, 0, 0) scale(1.004); box-shadow: 0 0 0 1.5px rgba(56, 189, 248, 0.58), 0 10px 26px -6px rgba(16, 185, 129, 0.28); }",
      "  100% { transform: translate3d(0, 0, 0) scale(1); box-shadow: 0 0 0 0 rgba(56, 189, 248, 0), 0 0 0 0 rgba(16, 185, 129, 0); }",
      "}",
      "@keyframes gsResultReadySheen {",
      "  0% { transform: translateX(-115%) skewX(-18deg); opacity: 0; }",
      "  28% { opacity: 0.72; }",
      "  100% { transform: translateX(125%) skewX(-18deg); opacity: 0; }",
      "}",
      ".gs-result-ready-pulse {",
      "  position: relative;",
      "  overflow: hidden;",
      "  border-radius: 8px;",
      "  animation: gsResultReadyPulse 0.68s cubic-bezier(0.22, 1, 0.36, 1) both;",
      "}",
      ".gs-result-ready-pulse::after {",
      "  content: '';",
      "  position: absolute;",
      "  inset: 0;",
      "  border-radius: inherit;",
      "  pointer-events: none;",
      "  background: linear-gradient(90deg, rgba(56, 189, 248, 0) 0%, rgba(56, 189, 248, 0.16) 44%, rgba(16, 185, 129, 0.22) 56%, rgba(56, 189, 248, 0) 100%);",
      "  animation: gsResultReadySheen 0.68s cubic-bezier(0.22, 1, 0.36, 1) both;",
      "}",
      "@keyframes gsCardSlideFadeIn {",
      "  0% { opacity: 0; transform: translate3d(0, 5px, 0); }",
      "  100% { opacity: 1; transform: translate3d(0, 0, 0); }",
      "}",
      ".timeline-scan-card, .gs-lib-card, .gs-bookmark-card, #sidePanelContent > .gs-metric-grid, #sidePanelContent .gs-metric-box {",
      "  animation: gsCardSlideFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1) both;",
      "}",
      ".timeline-scan-card:nth-child(2), .gs-lib-card:nth-child(2), .gs-metric-box:nth-child(2) { animation-delay: 0.025s; }",
      ".timeline-scan-card:nth-child(3), .gs-lib-card:nth-child(3), .gs-metric-box:nth-child(3) { animation-delay: 0.05s; }",
      ".timeline-scan-card:nth-child(4), .gs-lib-card:nth-child(4), .gs-metric-box:nth-child(4) { animation-delay: 0.075s; }"
    ].join("\n");
    document.head.appendChild(style);
  }

  function detectActiveTheme(explicitTheme) {
    if (explicitTheme === "light" || explicitTheme === "dark") {
      return explicitTheme;
    }
    var htmlTheme = document.documentElement && document.documentElement.getAttribute("data-theme");
    if (htmlTheme === "light" || htmlTheme === "dark") return htmlTheme;
    var bodyTheme = document.body && document.body.getAttribute("data-theme");
    if (bodyTheme === "light" || bodyTheme === "dark") return bodyTheme;
    if (root.STATE && (root.STATE.resolvedTheme === "light" || root.STATE.resolvedTheme === "dark")) {
      return root.STATE.resolvedTheme;
    }
    if (root.AppState && (root.AppState.theme === "light" || root.AppState.theme === "dark")) {
      return root.AppState.theme;
    }
    return "dark";
  }

  function discoverLogoSources(opts) {
    var darkEl = document.querySelector(".top-navbar .brand-logo-dark, .brand-logo-dark, .gs-logo-dark");
    var lightEl = document.querySelector(".top-navbar .brand-logo-light, .brand-logo-light, .gs-logo-light");
    return {
      dark: (opts && opts.logoDarkSrc) || (darkEl && darkEl.getAttribute("src")) || "/assets/logo_dark.png",
      light: (opts && opts.logoLightSrc) || (lightEl && lightEl.getAttribute("src")) || "/assets/logo_transparent.png"
    };
  }

  function findTargetLogoElement(targetSelector) {
    var selectors = [];
    if (targetSelector) selectors.push(targetSelector);
    selectors.push(
      ".top-navbar .brand-cluster .brand-logo-img",
      ".top-navbar .brand-cluster",
      ".gs-topbar .brand-cluster .brand-logo-img",
      ".gs-topbar .brand-cluster",
      ".brand-cluster .brand-logo-img",
      ".brand-cluster",
      ".gs-brand",
      ".brand-logo"
    );
    for (var i = 0; i < selectors.length; i++) {
      var nodes = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        var style = window.getComputedStyle(el);
        if (style.display !== "none" && style.visibility !== "hidden") {
          var rect = el.getBoundingClientRect();
          if (rect.width > 4 && rect.height > 4) {
            return { element: el, rect: rect };
          }
        }
      }
    }
    return null;
  }

  var state = {
    active: false,
    phase: "idle", // "idle" | "looping" | "converging" | "flying"
    rafId: null,
    fallbackTimerId: null,
    startTimeMs: 0,
    phaseStartTimeMs: 0,
    minLoopDurationMs: 0,
    convergeDurationMs: 320,
    flyDurationMs: 380,
    targetSelector: ".top-navbar .brand-cluster",
    theme: "dark",
    logoSources: { dark: "/assets/logo_dark.png", light: "/assets/logo_transparent.png" },
    overlayEl: null,
    backdropEl: null,
    cloudsLayerEl: null,
    cloudEls: [],
    auraEl: null,
    mergePulseEl: null,
    logoWrapEl: null,
    logoImgEl: null,
    hiddenNavLogoEl: null,
    hiddenNavLogoOrigOpacity: "",
    convergeStartStates: [],
    completePromise: null,
    completeResolve: null,
    pendingCompleteTimer: null
  };

  function ensureOverlayDom() {
    injectScopedStyles();
    var overlay = document.getElementById("gatherenLoadingOverlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "gatherenLoadingOverlay";
      overlay.className = "gatheren-loading-overlay hidden";
      overlay.setAttribute("aria-hidden", "true");
      document.body.appendChild(overlay);
    }

    if (!overlay.querySelector(".gatheren-loading-backdrop")) {
      overlay.innerHTML = "";
      var backdrop = document.createElement("div");
      backdrop.className = "gatheren-loading-backdrop";

      var aura = document.createElement("div");
      aura.className = "gatheren-loading-aura";

      var cloudsLayer = document.createElement("div");
      cloudsLayer.className = "gatheren-loading-clouds-layer";

      var cloudEls = [];
      for (var i = 0; i < CLOUDS_TEMPLATE.length; i++) {
        var cImg = document.createElement("img");
        cImg.className = "gatheren-loading-cloud";
        cImg.src = CLOUD_SPRITE_DATA_URI;
        cImg.alt = "";
        cImg.setAttribute("aria-hidden", "true");
        cloudsLayer.appendChild(cImg);
        cloudEls.push(cImg);
      }

      var mergePulse = document.createElement("div");
      mergePulse.className = "gatheren-loading-merge-pulse";

      var logoWrap = document.createElement("div");
      logoWrap.className = "gatheren-loading-logo-wrap";
      var logoImg = document.createElement("img");
      logoImg.className = "gatheren-loading-logo-img";
      logoImg.alt = "Gathering Cloud";
      logoWrap.appendChild(logoImg);

      overlay.appendChild(backdrop);
      overlay.appendChild(aura);
      overlay.appendChild(cloudsLayer);
      overlay.appendChild(mergePulse);
      overlay.appendChild(logoWrap);

      state.backdropEl = backdrop;
      state.auraEl = aura;
      state.cloudsLayerEl = cloudsLayer;
      state.cloudEls = cloudEls;
      state.mergePulseEl = mergePulse;
      state.logoWrapEl = logoWrap;
      state.logoImgEl = logoImg;
    } else if (!state.backdropEl) {
      state.backdropEl = overlay.querySelector(".gatheren-loading-backdrop");
      state.auraEl = overlay.querySelector(".gatheren-loading-aura");
      state.cloudsLayerEl = overlay.querySelector(".gatheren-loading-clouds-layer");
      state.cloudEls = Array.prototype.slice.call(overlay.querySelectorAll(".gatheren-loading-cloud"));
      state.mergePulseEl = overlay.querySelector(".gatheren-loading-merge-pulse");
      state.logoWrapEl = overlay.querySelector(".gatheren-loading-logo-wrap");
      state.logoImgEl = overlay.querySelector(".gatheren-loading-logo-img");
    }

    state.overlayEl = overlay;
    return overlay;
  }

  function computeLayoutMetrics() {
    var vw = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 1280);
    var vh = Math.max(240, window.innerHeight || document.documentElement.clientHeight || 720);
    var scaleFactor = Math.min(1.0, Math.max(0.46, Math.min(vw / 1600, vh / 920)));
    var centerLw = Math.round(620 * scaleFactor);
    var centerLh = Math.round(centerLw * (411 / 1024));
    var centerLx = vw / 2;
    var centerLy = vh / 2;

    var innerCloudCx = (centerLx - centerLw / 2) + centerLw * INNER_CLOUD_X_RATIO;
    var innerCloudCy = (centerLy - centerLh / 2) + centerLh * INNER_CLOUD_Y_RATIO;
    var innerCloudScale = (centerLw * INNER_CLOUD_W_RATIO) / CLOUD_BASE_W;

    return {
      vw: vw,
      vh: vh,
      scaleFactor: scaleFactor,
      centerLw: centerLw,
      centerLh: centerLh,
      centerLx: centerLx,
      centerLy: centerLy,
      innerCloudCx: innerCloudCx,
      innerCloudCy: innerCloudCy,
      innerCloudScale: innerCloudScale
    };
  }

  function getCloudPhase1Position(cfg, tSec, metrics) {
    var sf = metrics.scaleFactor;
    var dx = Math.sin(tSec * 0.75 + cfg.phase) * 95 * sf + Math.cos(tSec * 0.42 + cfg.phase * 1.7) * cfg.ax * sf;
    var dy = Math.sin(tSec * cfg.freq + cfg.phase) * cfg.ay * sf;
    return {
      cx: metrics.centerLx + cfg.ox * sf + dx,
      cy: metrics.centerLy + cfg.oy * sf + dy,
      scale: cfg.scale * sf,
      opacity: cfg.opacity
    };
  }

  function restoreNavLogoVisibility() {
    if (state.hiddenNavLogoEl) {
      state.hiddenNavLogoEl.style.opacity = state.hiddenNavLogoOrigOpacity;
      state.hiddenNavLogoEl = null;
      state.hiddenNavLogoOrigOpacity = "";
    }
  }

  function scheduleNextTick() {
    if (!state.active) return;
    if (state.rafId) {
      window.cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    if (state.fallbackTimerId) {
      clearTimeout(state.fallbackTimerId);
      state.fallbackTimerId = null;
    }
    state.rafId = window.requestAnimationFrame(function () {
      renderFrame();
    });
    state.fallbackTimerId = setTimeout(function () {
      renderFrame();
    }, 32);
  }

  function renderFrame() {
    if (!state.active) return;
    var nowMs = performance.now();

    var currentTheme = detectActiveTheme();
    if (currentTheme !== state.theme) {
      state.theme = currentTheme;
      state.overlayEl.setAttribute("data-loader-theme", currentTheme);
      var targetSrc = currentTheme === "light" ? state.logoSources.light : state.logoSources.dark;
      if (state.logoImgEl && state.logoImgEl.getAttribute("src") !== targetSrc) {
        state.logoImgEl.src = targetSrc;
      }
    }

    var tSec = (nowMs - state.startTimeMs) / 1000;
    var metrics = computeLayoutMetrics();
    var centerLx = metrics.centerLx;
    var centerLy = metrics.centerLy;
    var centerLw = metrics.centerLw;
    var centerLh = metrics.centerLh;

    var overlayAlpha = 1.0;
    var curLx = centerLx;
    var curLy = centerLy;
    var curLw = centerLw;
    var curLh = centerLh;
    var breathe = 0.5 + 0.5 * Math.sin(tSec * 2.6 - 0.5);
    var mergeBoost = 0.0;

    if (state.phase === "looping") {
      for (var i = 0; i < CLOUDS_TEMPLATE.length; i++) {
        var pos = getCloudPhase1Position(CLOUDS_TEMPLATE[i], tSec, metrics);
        var cw = CLOUD_BASE_W * pos.scale;
        var ch = CLOUD_BASE_H * pos.scale;
        var el = state.cloudEls[i];
        el.style.width = cw.toFixed(1) + "px";
        el.style.height = ch.toFixed(1) + "px";
        el.style.opacity = pos.opacity.toFixed(3);
        el.style.transform = "translate3d(" + (pos.cx - cw / 2).toFixed(1) + "px, " + (pos.cy - ch / 2).toFixed(1) + "px, 0)";
      }
      state.mergePulseEl.style.opacity = "0";
    } else if (state.phase === "converging") {
      var convElapsed = nowMs - state.phaseStartTimeMs;
      var rawP = Math.max(0, Math.min(1, convElapsed / Math.max(1, state.convergeDurationMs)));

      for (var j = 0; j < CLOUDS_TEMPLATE.length; j++) {
        var stagger = (j % 4) * 0.06;
        var localP = Math.max(0, Math.min(1, (rawP - stagger) / (1 - stagger)));
        var ep = easeInOutCubic(localP);
        var startSt = state.convergeStartStates[j] || getCloudPhase1Position(CLOUDS_TEMPLATE[j], tSec, metrics);
        var arcY = -28 * metrics.scaleFactor * Math.sin(Math.PI * ep) * (startSt.cy < metrics.innerCloudCy ? 1 : -1);
        var cx = startSt.cx + (metrics.innerCloudCx - startSt.cx) * ep;
        var cy = startSt.cy + (metrics.innerCloudCy - startSt.cy) * ep + arcY;
        var sc = startSt.scale + (metrics.innerCloudScale - startSt.scale) * ep;
        var op = startSt.opacity * (ep < 0.8 ? 1.0 : Math.max(0, (1.0 - ep) / 0.2));

        var cw2 = CLOUD_BASE_W * sc;
        var ch2 = CLOUD_BASE_H * sc;
        var el2 = state.cloudEls[j];
        el2.style.width = cw2.toFixed(1) + "px";
        el2.style.height = ch2.toFixed(1) + "px";
        el2.style.opacity = op.toFixed(3);
        el2.style.transform = "translate3d(" + (cx - cw2 / 2).toFixed(1) + "px, " + (cy - ch2 / 2).toFixed(1) + "px, 0)";
      }

      mergeBoost = Math.pow(Math.sin(Math.PI * Math.max(0, (rawP - 0.35) / 0.65)), 2);
      var mRad = centerLw * 0.34;
      state.mergePulseEl.style.width = mRad.toFixed(1) + "px";
      state.mergePulseEl.style.height = mRad.toFixed(1) + "px";
      state.mergePulseEl.style.opacity = (mergeBoost * 0.92).toFixed(3);
      state.mergePulseEl.style.transform =
        "translate3d(" + (metrics.innerCloudCx - mRad / 2).toFixed(1) + "px, " + (metrics.innerCloudCy - mRad / 2).toFixed(1) + "px, 0)";

      if (rawP >= 1.0) {
        // Transition to Phase 2B: Fly to Top-Left Header
        state.phase = "flying";
        state.phaseStartTimeMs = nowMs;
        for (var k = 0; k < state.cloudEls.length; k++) {
          state.cloudEls[k].style.opacity = "0";
        }
        var targetInfo = findTargetLogoElement(state.targetSelector);
        if (targetInfo && targetInfo.element) {
          state.hiddenNavLogoEl = targetInfo.element;
          state.hiddenNavLogoOrigOpacity = targetInfo.element.style.opacity || "";
          targetInfo.element.style.opacity = "0";
        }
      }
    } else if (state.phase === "flying") {
      var flyElapsed = nowMs - state.phaseStartTimeMs;
      var pFly = Math.max(0, Math.min(1, flyElapsed / Math.max(1, state.flyDurationMs)));
      var epFly = easeInOutCubic(pFly);

      var target = findTargetLogoElement(state.targetSelector);
      var navLh = 28;
      var navLw = Math.round(navLh * (1024 / 411));
      var navLx = 16 + navLw / 2;
      var navLy = 26;
      if (target && target.rect) {
        navLw = target.rect.width;
        navLh = target.rect.height;
        navLx = target.rect.left + navLw / 2;
        navLy = target.rect.top + navLh / 2;
      }

      curLx = centerLx + (navLx - centerLx) * epFly;
      curLy = centerLy + (navLy - centerLy) * epFly;
      curLw = centerLw + (navLw - centerLw) * epFly;
      curLh = centerLh + (navLh - centerLh) * epFly;
      overlayAlpha = 1.0 - epFly;
      breathe = (1.0 - epFly) * 0.35;
      mergeBoost = (1.0 - epFly) * 0.25;
      state.mergePulseEl.style.opacity = "0";

      if (pFly >= 1.0) {
        finishAndUnmount();
        return;
      }
    }

    state.backdropEl.style.opacity = overlayAlpha.toFixed(3);

    var auraStrength = breathe * 0.55 + mergeBoost * 0.95;
    if (auraStrength > 0.02 && overlayAlpha > 0.05) {
      var aw = curLw * (0.95 + 0.16 * mergeBoost);
      var ah = curLh * (1.25 + 0.22 * mergeBoost);
      var glowCol = state.theme === "light" ? "rgba(2, 132, 199, " : "rgba(56, 189, 248, ";
      var glowAlpha = Math.min(0.55, (state.theme === "light" ? 0.18 : 0.28) * auraStrength) * overlayAlpha;
      state.auraEl.style.width = aw.toFixed(1) + "px";
      state.auraEl.style.height = ah.toFixed(1) + "px";
      state.auraEl.style.background = glowCol + glowAlpha.toFixed(3) + ")";
      state.auraEl.style.opacity = "1";
      state.auraEl.style.transform = "translate3d(" + (curLx - aw / 2).toFixed(1) + "px, " + (curLy - ah / 2).toFixed(1) + "px, 0)";
    } else {
      state.auraEl.style.opacity = "0";
    }

    state.logoWrapEl.style.width = curLw.toFixed(1) + "px";
    state.logoWrapEl.style.height = curLh.toFixed(1) + "px";
    state.logoWrapEl.style.transform = "translate3d(" + (curLx - curLw / 2).toFixed(1) + "px, " + (curLy - curLh / 2).toFixed(1) + "px, 0)";

    var brightnessVal = 0.95 + 0.14 * breathe + 0.18 * mergeBoost;
    var dropAlpha = (0.12 + 0.22 * breathe + 0.35 * mergeBoost) * overlayAlpha;
    if (state.phase === "flying" && overlayAlpha < 0.25) {
      state.logoWrapEl.style.filter = "none";
      state.logoWrapEl.style.opacity = "1";
    } else {
      var logoOpacity = state.phase === "looping" ? (0.88 + 0.12 * breathe) : 1.0;
      state.logoWrapEl.style.opacity = logoOpacity.toFixed(3);
      state.logoWrapEl.style.filter =
        "brightness(" + brightnessVal.toFixed(3) + ") drop-shadow(0 0 18px rgba(56, 189, 248, " + dropAlpha.toFixed(3) + "))";
    }

    scheduleNextTick();
  }

  function beginConvergence() {
    if (!state.active) {
      if (state.completeResolve) {
        var res0 = state.completeResolve;
        state.completeResolve = null;
        state.completePromise = null;
        res0();
      }
      return;
    }
    if (state.overlayEl) {
      state.overlayEl.style.pointerEvents = "none";
    }
    var nowMs = performance.now();
    var tSec = (nowMs - state.startTimeMs) / 1000;
    var metrics = computeLayoutMetrics();
    state.convergeStartStates = [];
    for (var i = 0; i < CLOUDS_TEMPLATE.length; i++) {
      state.convergeStartStates.push(getCloudPhase1Position(CLOUDS_TEMPLATE[i], tSec, metrics));
    }
    state.phase = "converging";
    state.phaseStartTimeMs = nowMs;
  }

  function finishAndUnmount() {
    if (state.rafId) {
      window.cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    if (state.fallbackTimerId) {
      clearTimeout(state.fallbackTimerId);
      state.fallbackTimerId = null;
    }
    if (state.pendingCompleteTimer) {
      clearTimeout(state.pendingCompleteTimer);
      state.pendingCompleteTimer = null;
    }
    restoreNavLogoVisibility();
    state.active = false;
    state.phase = "idle";
    if (state.overlayEl) {
      state.overlayEl.style.pointerEvents = "";
      state.overlayEl.classList.add("hidden");
      state.overlayEl.setAttribute("aria-hidden", "true");
    }
    if (state.completeResolve) {
      var resolveFn = state.completeResolve;
      state.completeResolve = null;
      state.completePromise = null;
      resolveFn();
    }
  }

  var lastClickOrigin = { x: null, y: null, timeMs: 0 };

  function recordInteractionOrigin(evt) {
    try {
      if (!evt) return;
      var target = evt.target && evt.target.closest
        ? evt.target.closest("button, [role='button'], [role='option'], input[type='checkbox'], .status-chip, .btn-xs, .btn-sm, .btn-accent") || evt.target
        : evt.target;
      if (target && typeof target.getBoundingClientRect === "function") {
        var r = target.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.width < 520 && r.height < 220) {
          lastClickOrigin.x = r.left + r.width / 2;
          lastClickOrigin.y = r.top + r.height / 2;
          lastClickOrigin.timeMs = performance.now();
          return;
        }
      }
      if (typeof evt.clientX === "number" && typeof evt.clientY === "number" && (evt.clientX > 0 || evt.clientY > 0)) {
        lastClickOrigin.x = evt.clientX;
        lastClickOrigin.y = evt.clientY;
        lastClickOrigin.timeMs = performance.now();
      }
    } catch (_) {}
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("pointerdown", recordInteractionOrigin, true);
    document.addEventListener("click", recordInteractionOrigin, true);
    document.addEventListener(
      "keydown",
      function (e) {
        if (e && (e.key === "Enter" || e.key === " ")) {
          recordInteractionOrigin(e);
        }
      },
      true
    );
  }

  function resolveBurstOrigin(opts, vw, vh) {
    if (opts && typeof opts.originX === "number" && typeof opts.originY === "number") {
      return { x: opts.originX, y: opts.originY };
    }
    var anchor = opts && (opts.anchorEl || opts.element || opts.target);
    if (typeof anchor === "string" && typeof document !== "undefined") {
      anchor = document.querySelector(anchor);
    }
    if (anchor) {
      if (typeof anchor.originX === "number" && typeof anchor.originY === "number") {
        return { x: anchor.originX, y: anchor.originY };
      }
      if (typeof anchor.x === "number" && typeof anchor.y === "number") {
        return { x: anchor.x, y: anchor.y };
      }
      if (typeof anchor.getBoundingClientRect === "function") {
        var rect = anchor.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
      }
    }
    if (
      typeof lastClickOrigin.x === "number" &&
      typeof lastClickOrigin.y === "number" &&
      performance.now() - lastClickOrigin.timeMs < 4000
    ) {
      return { x: lastClickOrigin.x, y: lastClickOrigin.y };
    }
    return { x: vw / 2, y: vh / 2 };
  }

  function ensureBurstLayerDom() {
    injectScopedStyles();
    var layer = document.querySelector("[data-gatheren-burst-layer]");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "gatheren-burst-layer";
      layer.setAttribute("data-gatheren-burst-layer", "1");
      layer.setAttribute("aria-hidden", "true");
      document.body.appendChild(layer);
    }
    return layer;
  }

  var GatherenLoader = {
    /**
     * Starts Phase 1 looping loading animation.
     * @param {Object} [options]
     * @param {string} [options.targetSelector=".top-navbar .brand-cluster"]
     * @param {string} [options.theme] - "dark" | "light" (auto-detected if omitted)
     * @param {string} [options.logoDarkSrc]
     * @param {string} [options.logoLightSrc]
     * @param {number} [options.minLoopDurationMs=0]
     * @param {number} [options.convergeDurationMs=320]
     * @param {number} [options.flyDurationMs=380]
     * @param {boolean} [options.forceFullDuration=false]
     */
    start: function (options) {
      var opts = options || {};
      var isAutomatedWebdriver = Boolean(
        navigator && navigator.webdriver && !root.__GATHEREN_TEST_LOADER_ANIMATION && !opts.forceFullDuration
      );

      if (state.pendingCompleteTimer) {
        clearTimeout(state.pendingCompleteTimer);
        state.pendingCompleteTimer = null;
      }
      if (state.rafId) {
        window.cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }
      if (state.fallbackTimerId) {
        clearTimeout(state.fallbackTimerId);
        state.fallbackTimerId = null;
      }
      restoreNavLogoVisibility();

      var overlay = ensureOverlayDom();
      state.targetSelector = opts.targetSelector || ".top-navbar .brand-cluster";
      state.logoSources = discoverLogoSources(opts);
      state.theme = detectActiveTheme(opts.theme);
      state.minLoopDurationMs =
        typeof opts.minLoopDurationMs === "number" ? opts.minLoopDurationMs : 0;
      state.convergeDurationMs =
        typeof opts.convergeDurationMs === "number" ? opts.convergeDurationMs : isAutomatedWebdriver ? 35 : 320;
      state.flyDurationMs =
        typeof opts.flyDurationMs === "number" ? opts.flyDurationMs : isAutomatedWebdriver ? 35 : 380;

      overlay.setAttribute("data-loader-theme", state.theme);
      overlay.style.pointerEvents = "all";
      state.logoImgEl.src = state.theme === "light" ? state.logoSources.light : state.logoSources.dark;
      state.backdropEl.style.opacity = "1";
      state.mergePulseEl.style.opacity = "0";

      overlay.classList.remove("hidden");
      overlay.setAttribute("aria-hidden", "false");

      state.active = true;
      state.phase = "looping";
      state.startTimeMs = performance.now();
      state.phaseStartTimeMs = state.startTimeMs;
      state.completePromise = null;
      state.completeResolve = null;

      renderFrame();
      return GatherenLoader;
    },

    /**
     * Triggers localized celebratory clouds flying outward around the clicked button
     * (e.g., when a task is created, a new comment is added, or a task is marked "done").
     * When options.includeTrophy is true, mixes flying clouds with Trophy emojis of
     * roughly the same visual size.
     * @param {Object} [options]
     * @param {boolean} [options.includeTrophy=false]
     * @param {Element|string|Object} [options.anchorEl] - Button element, selector, or {originX, originY}
     * @param {number} [options.originX]
     * @param {number} [options.originY]
     * @param {number} [options.radius] - Localized burst radius in px (default ~95-115px)
     * @param {number} [options.count]
     * @param {number} [options.durationMs]
     * @returns {Promise<void>}
     */
    burstClouds: function (options) {
      var opts = options || {};
      var includeTrophy = Boolean(opts.includeTrophy);
      var isAutomatedWebdriver = Boolean(
        navigator && navigator.webdriver && !root.__GATHEREN_TEST_LOADER_ANIMATION && !opts.forceFullDuration
      );
      var vw = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 1280);
      var vh = Math.max(240, window.innerHeight || document.documentElement.clientHeight || 720);
      var scaleFactor = Math.min(1.0, Math.max(0.75, Math.min(vw / 1440, vh / 860)));
      var origin = resolveBurstOrigin(opts, vw, vh);
      var originX = Math.max(24, Math.min(vw - 24, origin.x));
      var originY = Math.max(24, Math.min(vh - 24, origin.y));
      var totalCount = typeof opts.count === "number" ? opts.count : includeTrophy ? 12 : 10;
      var durationMs =
        typeof opts.durationMs === "number"
          ? opts.durationMs
          : isAutomatedWebdriver
          ? 60
          : includeTrophy
          ? 820
          : 680;

      var layer = ensureBurstLayerDom();
      var trophyChar = String.fromCodePoint(0x1f3c6);
      var trophyModulo = opts.fewTrophies ? 3 : 2;
      var maxRadius =
        typeof opts.radius === "number"
          ? opts.radius
          : Math.round((includeTrophy ? 112 : 94) * scaleFactor);
      var particles = [];

      for (var i = 0; i < totalCount; i++) {
        var isTrophy = includeTrophy && i % trophyModulo === 1;
        var baseAngle = (i / totalCount) * Math.PI * 2;
        var angleJitter = ((i % 3) - 1) * 0.12;
        var angle = baseAngle + angleJitter;
        var speedRatio = 0.64 + ((i * 7) % 5) * 0.1;
        var dist = maxRadius * speedRatio;
        var startRadius = (5 + (i % 3) * 4) * scaleFactor;
        var itemScale = (0.17 + ((i * 3) % 4) * 0.02) * scaleFactor;
        var w = isTrophy ? Math.round(92 * itemScale * 1.9) : Math.round(CLOUD_BASE_W * itemScale);
        var h = isTrophy ? w : Math.round(CLOUD_BASE_H * itemScale);

        var el;
        if (isTrophy) {
          el = document.createElement("div");
          el.className = "gatheren-burst-item gatheren-burst-trophy";
          el.textContent = trophyChar;
          el.style.width = w + "px";
          el.style.height = h + "px";
          el.style.fontSize = Math.round(w * 0.84) + "px";
        } else {
          el = document.createElement("img");
          el.className = "gatheren-burst-item gatheren-burst-cloud";
          el.src = CLOUD_SPRITE_DATA_URI;
          el.alt = "";
          el.style.width = w + "px";
          el.style.height = h + "px";
        }
        el.setAttribute("aria-hidden", "true");
        layer.appendChild(el);

        particles.push({
          el: el,
          isTrophy: isTrophy,
          w: w,
          h: h,
          sx: originX + Math.cos(angle) * startRadius,
          sy: originY + Math.sin(angle) * startRadius,
          tx: originX + Math.cos(angle) * dist,
          ty: originY + Math.sin(angle) * dist,
          arcLift: ((i % 2 === 0 ? -1 : 1) * (8 + (i % 3) * 4)) * scaleFactor,
          rotStart: isTrophy ? (i % 2 === 0 ? -10 : 10) : 0,
          rotEnd: isTrophy ? (i % 2 === 0 ? 15 : -15) : (i % 2 === 0 ? 7 : -7),
          stagger: (i % 4) * 0.035
        });
      }

      var startMs = performance.now();
      return new Promise(function (resolve) {
        var rafHandle = null;
        var timerHandle = null;
        var finished = false;

        function cleanupBurst() {
          if (finished) return;
          finished = true;
          if (rafHandle) window.cancelAnimationFrame(rafHandle);
          if (timerHandle) clearTimeout(timerHandle);
          for (var m = 0; m < particles.length; m++) {
            if (particles[m].el && particles[m].el.parentNode) {
              particles[m].el.parentNode.removeChild(particles[m].el);
            }
          }
          resolve();
        }

        function stepBurst() {
          if (finished) return;
          var elapsed = performance.now() - startMs;
          var rawP = Math.max(0, Math.min(1, elapsed / Math.max(1, durationMs)));

          for (var pIdx = 0; pIdx < particles.length; pIdx++) {
            var pt = particles[pIdx];
            var lp = Math.max(0, Math.min(1, (rawP - pt.stagger) / (1 - pt.stagger)));
            var easeOut = 1 - Math.pow(1 - lp, 3);
            var cx = pt.sx + (pt.tx - pt.sx) * easeOut;
            var cy = pt.sy + (pt.ty - pt.sy) * easeOut + Math.sin(lp * Math.PI) * pt.arcLift;
            var scalePop = lp < 0.15 ? 0.55 + (lp / 0.15) * 0.55 : 1.1 - (lp - 0.15) * 0.22;
            var opacity = lp < 0.12 ? lp / 0.12 : lp > 0.68 ? Math.max(0, (1 - lp) / 0.32) : 0.96;
            var rot = pt.rotStart + (pt.rotEnd - pt.rotStart) * easeOut;

            pt.el.style.opacity = opacity.toFixed(3);
            pt.el.style.transform =
              "translate3d(" +
              (cx - pt.w / 2).toFixed(1) +
              "px, " +
              (cy - pt.h / 2).toFixed(1) +
              "px, 0) scale(" +
              scalePop.toFixed(3) +
              ") rotate(" +
              rot.toFixed(1) +
              "deg)";
          }

          if (rawP >= 1.0) {
            cleanupBurst();
            return;
          }
          if (rafHandle) window.cancelAnimationFrame(rafHandle);
          if (timerHandle) clearTimeout(timerHandle);
          rafHandle = window.requestAnimationFrame(stepBurst);
          timerHandle = setTimeout(stepBurst, 32);
        }

        stepBurst();
      });
    },

    /**
     * Plays a synthesized congratulatory fanfare chime via Web Audio API.
     */
    playCelebrationSound: function () {
      try {
        var AudioCtx = root.AudioContext || root.webkitAudioContext;
        if (!AudioCtx) return;
        var ctx = new AudioCtx();
        if (ctx.state === "suspended" && typeof ctx.resume === "function") {
          ctx.resume().catch(function () {});
        }
        var now = ctx.currentTime;
        var notes = [
          { freq: 523.25, start: 0.0, dur: 0.22, gain: 0.11, type: "triangle" },
          { freq: 659.25, start: 0.09, dur: 0.24, gain: 0.12, type: "triangle" },
          { freq: 783.99, start: 0.18, dur: 0.28, gain: 0.13, type: "triangle" },
          { freq: 1046.5, start: 0.28, dur: 0.62, gain: 0.16, type: "triangle" },
          { freq: 1318.51, start: 0.34, dur: 0.56, gain: 0.09, type: "sine" },
          { freq: 1567.98, start: 0.4, dur: 0.65, gain: 0.1, type: "sine" }
        ];
        for (var i = 0; i < notes.length; i++) {
          var n = notes[i];
          var osc = ctx.createOscillator();
          var g = ctx.createGain();
          osc.type = n.type;
          osc.frequency.setValueAtTime(n.freq, now + n.start);
          g.gain.setValueAtTime(0.0001, now + n.start);
          g.gain.exponentialRampToValueAtTime(n.gain, now + n.start + 0.025);
          g.gain.exponentialRampToValueAtTime(0.0001, now + n.start + n.dur);
          osc.connect(g);
          g.connect(ctx.destination);
          osc.start(now + n.start);
          osc.stop(now + n.start + n.dur + 0.04);
        }
        setTimeout(function () {
          try {
            if (typeof ctx.close === "function") ctx.close();
          } catch (_) {}
        }, 1400);
      } catch (_) {}
    },

    /**
     * Shows the grand "Task completed" / "任務完成" popup (approx the size of the
     * central loading logo) with the cloud covering the bottom-left part of a big
     * Trophy emoji, plays a congratulatory sound effect, and launches Confetti + Trophy
     * emojis flying away from it.
     * @param {Object} [options]
     * @param {string} [options.lang] - "en" | "zh" (auto-detected if omitted)
     * @param {string} [options.text] - Explicit override text
     * @param {number} [options.durationMs=1550]
     * @param {boolean} [options.muteSound=false]
     * @returns {Promise<void>}
     */
    celebrateTaskCompletion: function (options) {
      var opts = options || {};
      var isAutomatedWebdriver = Boolean(
        navigator && navigator.webdriver && !root.__GATHEREN_TEST_LOADER_ANIMATION && !opts.forceFullDuration
      );
      var vw = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 1280);
      var vh = Math.max(240, window.innerHeight || document.documentElement.clientHeight || 720);
      var scaleFactor = Math.min(1.0, Math.max(0.52, Math.min(vw / 1600, vh / 920)));

      // Size matches the central logo on the initial loading animation (~600x300 scaled)
      var popupW = Math.round(600 * scaleFactor);
      var popupH = Math.round(300 * scaleFactor);
      var durationMs =
        typeof opts.durationMs === "number" ? opts.durationMs : isAutomatedWebdriver ? 70 : 1550;

      var activeLang =
        opts.lang ||
        (root.AppState && root.AppState.lang) ||
        (document.documentElement && document.documentElement.getAttribute("lang")) ||
        "zh";
      var isEn = String(activeLang).toLowerCase().indexOf("en") === 0;
      var labelText = opts.text || (isEn ? "Task completed" : "\u4efb\u52d9\u5b8c\u6210");

      if (!opts.muteSound && !isAutomatedWebdriver) {
        GatherenLoader.playCelebrationSound();
      }

      var layer = ensureBurstLayerDom();
      var trophyChar = String.fromCodePoint(0x1f3c6);
      var confettiChar = String.fromCodePoint(0x1f38a);

      // Build popup container (Cloud covering bottom-left of big Trophy)
      var popupEl = document.createElement("div");
      popupEl.className = "gatheren-task-complete-popup";
      popupEl.style.width = popupW + "px";
      popupEl.style.height = popupH + "px";

      var auraEl = document.createElement("div");
      auraEl.className = "gatheren-complete-aura";
      popupEl.appendChild(auraEl);

      // Big Trophy positioned in upper-right/center so its bottom-left is covered by the cloud
      var bigTrophyEl = document.createElement("div");
      bigTrophyEl.className = "gatheren-complete-big-trophy";
      var trophySize = Math.round(188 * scaleFactor);
      bigTrophyEl.style.width = trophySize + "px";
      bigTrophyEl.style.height = trophySize + "px";
      bigTrophyEl.style.fontSize = Math.round(168 * scaleFactor) + "px";
      bigTrophyEl.style.left = Math.round(popupW * 0.44) + "px";
      bigTrophyEl.style.top = Math.round(popupH * 0.02) + "px";
      bigTrophyEl.textContent = trophyChar;
      popupEl.appendChild(bigTrophyEl);

      // Cloud covering the bottom-left part of the big Trophy
      var cloudWrapEl = document.createElement("div");
      cloudWrapEl.className = "gatheren-complete-cloud-wrap";
      var cloudW = Math.round(372 * scaleFactor);
      var cloudH = Math.round(cloudW * (CLOUD_BASE_H / CLOUD_BASE_W));
      cloudWrapEl.style.width = cloudW + "px";
      cloudWrapEl.style.height = cloudH + "px";
      cloudWrapEl.style.left = Math.round(popupW * 0.07) + "px";
      cloudWrapEl.style.top = Math.round(popupH * 0.20) + "px";

      var cloudImgEl = document.createElement("img");
      cloudImgEl.className = "gatheren-complete-cloud-img";
      cloudImgEl.src = CLOUD_SPRITE_DATA_URI;
      cloudImgEl.alt = "";
      cloudWrapEl.appendChild(cloudImgEl);

      var textEl = document.createElement("div");
      textEl.className = "gatheren-complete-cloud-text";
      textEl.textContent = labelText;
      textEl.style.fontSize = Math.round((isEn ? 26 : 31) * scaleFactor) + "px";
      cloudWrapEl.appendChild(textEl);

      popupEl.appendChild(cloudWrapEl);
      layer.appendChild(popupEl);

      // Spawn flying Confetti (0x1F38A) + Trophy (0x1F3C6) emojis radiating outward from the popup
      var cx0 = vw / 2;
      var cy0 = vh / 2;
      var particleCount = 18;
      var maxFlyRadius = Math.round(340 * scaleFactor);
      var particles = [];

      for (var i = 0; i < particleCount; i++) {
        var isConfetti = i % 2 === 0;
        var angle = (i / particleCount) * Math.PI * 2 + ((i % 3) - 1) * 0.1;
        var dist = maxFlyRadius * (0.68 + ((i * 5) % 5) * 0.1);
        var startR = (42 + (i % 4) * 16) * scaleFactor;
        var pSize = Math.round((42 + (i % 3) * 8) * scaleFactor);

        var pEl = document.createElement("div");
        pEl.className = "gatheren-burst-item gatheren-burst-trophy";
        pEl.textContent = isConfetti ? confettiChar : trophyChar;
        pEl.style.width = pSize + "px";
        pEl.style.height = pSize + "px";
        pEl.style.fontSize = Math.round(pSize * 0.86) + "px";
        pEl.setAttribute("aria-hidden", "true");
        layer.appendChild(pEl);

        particles.push({
          el: pEl,
          size: pSize,
          sx: cx0 + Math.cos(angle) * startR,
          sy: cy0 + Math.sin(angle) * startR,
          tx: cx0 + Math.cos(angle) * dist,
          ty: cy0 + Math.sin(angle) * dist,
          arcLift: ((i % 2 === 0 ? -1 : 1) * (18 + (i % 3) * 10)) * scaleFactor,
          rotStart: isConfetti ? -18 : 12,
          rotEnd: isConfetti ? 28 : -22,
          stagger: (i % 5) * 0.035
        });
      }

      var startMs = performance.now();
      return new Promise(function (resolve) {
        var rafHandle = null;
        var timerHandle = null;
        var finished = false;

        function cleanupCelebration() {
          if (finished) return;
          finished = true;
          if (rafHandle) window.cancelAnimationFrame(rafHandle);
          if (timerHandle) clearTimeout(timerHandle);
          if (popupEl && popupEl.parentNode) {
            popupEl.parentNode.removeChild(popupEl);
          }
          for (var m = 0; m < particles.length; m++) {
            if (particles[m].el && particles[m].el.parentNode) {
              particles[m].el.parentNode.removeChild(particles[m].el);
            }
          }
          resolve();
        }

        function stepCelebration() {
          if (finished) return;
          var elapsed = performance.now() - startMs;
          var rawP = Math.max(0, Math.min(1, elapsed / Math.max(1, durationMs)));

          // Popup spring entrance (0..0.22), hold with gentle float (0.22..0.78), smooth exit (0.78..1.0)
          var popScale = 1.0;
          var popOpacity = 1.0;
          var trophyTilt = 0.0;
          if (rawP < 0.22) {
            var epIn = rawP / 0.22;
            var backOut = 1 + 1.8 * Math.pow(epIn - 1, 3) + 0.8 * Math.pow(epIn - 1, 2);
            popScale = 0.42 + 0.58 * backOut;
            popOpacity = Math.min(1, epIn * 1.4);
            trophyTilt = Math.sin(epIn * Math.PI) * 8;
          } else if (rawP < 0.78) {
            var holdP = (rawP - 0.22) / 0.56;
            popScale = 1.0 + 0.025 * Math.sin(holdP * Math.PI * 2);
            popOpacity = 1.0;
            trophyTilt = Math.sin(holdP * Math.PI * 3) * 4;
          } else {
            var epOut = (rawP - 0.78) / 0.22;
            popScale = 1.0 + 0.08 * epOut;
            popOpacity = Math.max(0, 1 - epOut);
          }

          popupEl.style.opacity = popOpacity.toFixed(3);
          popupEl.style.transform =
            "translate3d(-50%, -50%, 0) scale(" + popScale.toFixed(3) + ")";
          bigTrophyEl.style.transform = "rotate(" + trophyTilt.toFixed(2) + "deg)";

          for (var pIdx = 0; pIdx < particles.length; pIdx++) {
            var pt = particles[pIdx];
            var lp = Math.max(0, Math.min(1, (rawP - pt.stagger) / (1 - pt.stagger)));
            var easeOut = 1 - Math.pow(1 - lp, 3);
            var px = pt.sx + (pt.tx - pt.sx) * easeOut;
            var py = pt.sy + (pt.ty - pt.sy) * easeOut + Math.sin(lp * Math.PI) * pt.arcLift;
            var pScale = lp < 0.16 ? 0.45 + (lp / 0.16) * 0.65 : 1.1 - (lp - 0.16) * 0.25;
            var pOp = lp < 0.12 ? lp / 0.12 : lp > 0.68 ? Math.max(0, (1 - lp) / 0.32) : 0.98;
            var pRot = pt.rotStart + (pt.rotEnd - pt.rotStart) * easeOut;

            pt.el.style.opacity = pOp.toFixed(3);
            pt.el.style.transform =
              "translate3d(" +
              (px - pt.size / 2).toFixed(1) +
              "px, " +
              (py - pt.size / 2).toFixed(1) +
              "px, 0) scale(" +
              pScale.toFixed(3) +
              ") rotate(" +
              pRot.toFixed(1) +
              "deg)";
          }

          if (rawP >= 1.0) {
            cleanupCelebration();
            return;
          }
          if (rafHandle) window.cancelAnimationFrame(rafHandle);
          if (timerHandle) clearTimeout(timerHandle);
          rafHandle = window.requestAnimationFrame(stepCelebration);
          timerHandle = setTimeout(stepCelebration, 32);
        }

        stepCelebration();
      });
    },

    /**
     * Triggers Phase 2 (Step 2A Cloud Convergence -> Step 2B Fly to Top-Left Header)
     * once minLoopDurationMs has elapsed, returning a Promise that resolves when done.
     * @returns {Promise<void>}
     */
    complete: function () {
      if (!state.active) {
        return Promise.resolve();
      }
      if (state.completePromise) {
        return state.completePromise;
      }
      state.completePromise = new Promise(function (resolve) {
        state.completeResolve = resolve;
        var elapsed = performance.now() - state.startTimeMs;
        var remaining = Math.max(0, state.minLoopDurationMs - elapsed);
        if (remaining <= 0) {
          beginConvergence();
        } else {
          state.pendingCompleteTimer = setTimeout(function () {
            state.pendingCompleteTimer = null;
            beginConvergence();
          }, remaining);
        }
      });
      return state.completePromise;
    },

    /**
     * Convenience wrapper: starts Phase 1, awaits asyncTaskFn(), then runs Phase 2.
     * @param {Function|Promise} asyncTaskOrPromise
     * @param {Object} [options]
     * @returns {Promise<*>}
     */
    runDuring: function (asyncTaskOrPromise, options) {
      GatherenLoader.start(options);
      var taskPromise;
      try {
        taskPromise = typeof asyncTaskOrPromise === "function" ? Promise.resolve(asyncTaskOrPromise()) : Promise.resolve(asyncTaskOrPromise);
      } catch (err) {
        GatherenLoader.hideImmediate();
        return Promise.reject(err);
      }
      return taskPromise.then(
        function (result) {
          return GatherenLoader.complete().then(function () {
            return result;
          });
        },
        function (err) {
          GatherenLoader.hideImmediate();
          throw err;
        }
      );
    },

    /**
     * Subtle, trophy-free result-ready animation: applies a specular cyan-emerald
     * glow sweep + gentle spring settle on the target container and optionally
     * emits a subtle cloud puff (strictly NO trophies and NO fanfare sound).
     * @param {Element|string} [targetElOrSelector]
     * @param {Object} [options]
     * @returns {Promise<void>}
     */
    pulseResultReady: function (targetElOrSelector, options) {
      injectScopedStyles();
      var opts = options || {};
      var targetEl = null;
      if (typeof targetElOrSelector === "string" && targetElOrSelector) {
        try {
          targetEl = document.querySelector(targetElOrSelector);
        } catch (_e) {}
      } else if (targetElOrSelector && typeof targetElOrSelector.getBoundingClientRect === "function") {
        targetEl = targetElOrSelector;
      }
      if (targetEl && targetEl.classList) {
        if (targetEl._gsPulseCleanupTimer) {
          clearTimeout(targetEl._gsPulseCleanupTimer);
        }
        targetEl.classList.remove("gs-result-ready-pulse");
        void targetEl.offsetWidth;
        targetEl.classList.add("gs-result-ready-pulse");
        targetEl._gsPulseCleanupTimer = setTimeout(function () {
          targetEl.classList.remove("gs-result-ready-pulse");
          targetEl._gsPulseCleanupTimer = null;
        }, 720);
      }
      if (opts.burst === false) {
        return Promise.resolve();
      }
      return GatherenLoader.burstClouds({
        includeTrophy: false,
        anchorEl: opts.anchorEl || targetEl || undefined,
        count: typeof opts.count === "number" ? opts.count : 6,
        radius: typeof opts.radius === "number" ? opts.radius : 68,
        durationMs: typeof opts.durationMs === "number" ? opts.durationMs : 560
      });
    },

    /**
     * Smooth 3D Studio camera entry / reset glide (520ms cubic ease-out).
     * Assumes studioThree.camera.position and studioThree.controls.target have just
     * been set to their target framed coordinates. On automated webdriver (unless
     * forced), keeps exact final coordinates synchronously for deterministic tests.
     * @param {Object} studioThree
     * @param {Object} [options]
     * @returns {Promise<void>}
     */
    glideStudioCamera: function (studioThree, options) {
      var opts = options || {};
      if (!studioThree || !studioThree.camera || !studioThree.controls || !studioThree.controls.target) {
        return Promise.resolve();
      }
      var isAutomatedWebdriver = Boolean(
        navigator && navigator.webdriver && !root.__GATHEREN_TEST_LOADER_ANIMATION && !opts.forceGlide
      );
      if (isAutomatedWebdriver) {
        return Promise.resolve();
      }
      if (typeof studioThree._gsCamGlideCancel === "function") {
        studioThree._gsCamGlideCancel();
      }
      var cam = studioThree.camera;
      var ctrl = studioThree.controls;
      var endX = Number(cam.position.x) || 0;
      var endY = Number(cam.position.y) || 0;
      var endZ = Number(cam.position.z) || 0;
      var tgtX = Number(ctrl.target.x) || 0;
      var tgtY = Number(ctrl.target.y) || 0;
      var tgtZ = Number(ctrl.target.z) || 0;
      var dx = endX - tgtX;
      var dy = endY - tgtY;
      var dz = endZ - tgtZ;
      var dist = Math.hypot(dx, dy, dz) || 12;
      var startX = tgtX + dx * 1.16;
      var startY = tgtY + dy * 1.16 + dist * 0.08;
      var startZ = tgtZ + dz * 1.16;
      var startTgtY = tgtY - dist * 0.025;
      var durationMs = typeof opts.durationMs === "number" ? Math.max(80, opts.durationMs) : 520;
      var startMs = performance.now();

      return new Promise(function (resolve) {
        var rafId = null;
        var cancelled = false;
        var domEl = studioThree.renderer && studioThree.renderer.domElement;

        function finishGlide(snapToEnd) {
          if (cancelled) return;
          cancelled = true;
          if (rafId) window.cancelAnimationFrame(rafId);
          if (domEl) {
            domEl.removeEventListener("pointerdown", onUserInteract);
            domEl.removeEventListener("wheel", onUserInteract);
            domEl.removeEventListener("touchstart", onUserInteract);
          }
          studioThree._gsCamGlideCancel = null;
          if (snapToEnd) {
            ctrl.target.set(tgtX, tgtY, tgtZ);
            cam.position.set(endX, endY, endZ);
            cam.lookAt(tgtX, tgtY, tgtZ);
            ctrl.update();
            cam.updateMatrixWorld(true);
            if (studioThree.renderer && studioThree.scene) {
              studioThree.renderer.render(studioThree.scene, cam);
            }
          }
          resolve();
        }

        function onUserInteract() {
          finishGlide(false);
        }

        if (domEl) {
          domEl.addEventListener("pointerdown", onUserInteract, { passive: true });
          domEl.addEventListener("wheel", onUserInteract, { passive: true });
          domEl.addEventListener("touchstart", onUserInteract, { passive: true });
        }
        studioThree._gsCamGlideCancel = function () {
          finishGlide(true);
        };

        function stepGlide() {
          if (cancelled) return;
          var elapsed = performance.now() - startMs;
          var t = Math.max(0, Math.min(1, elapsed / durationMs));
          var ease = 1 - Math.pow(1 - t, 3);
          var curTgtY = startTgtY + (tgtY - startTgtY) * ease;
          ctrl.target.set(tgtX, curTgtY, tgtZ);
          cam.position.set(
            startX + (endX - startX) * ease,
            startY + (endY - startY) * ease,
            startZ + (endZ - startZ) * ease
          );
          cam.lookAt(tgtX, curTgtY, tgtZ);
          ctrl.update();
          cam.updateMatrixWorld(true);
          if (studioThree.renderer && studioThree.scene) {
            studioThree.renderer.render(studioThree.scene, cam);
          }
          if (t >= 1) {
            finishGlide(true);
            return;
          }
          rafId = window.requestAnimationFrame(stepGlide);
        }

        stepGlide();
      });
    },

    /**
     * Immediately hides the loader overlay (e.g. on logout or auth lock).
     */
    hideImmediate: function () {
      finishAndUnmount();
    },

    /**
     * Returns current loader state for diagnostics/tests.
     */
    getState: function () {
      return {
        active: state.active,
        phase: state.phase,
        theme: state.theme
      };
    }
  };

  root.GatherenLoader = GatherenLoader;
  root.GatherenLoadingAnimation = GatherenLoader;
})(typeof window !== "undefined" ? window : this);
